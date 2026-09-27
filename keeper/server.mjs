// referee keeper: archives and forwards each game's signed steps, and watches
// the channel to answer disputes, resolve them and settle finished games.
//
// Its trust model is the prover gateway's: it accepts only steps that verify,
// so it cannot forge a move, and both players keep their own copies, so it can
// delay or withhold but not rewrite. It never holds player keys; its own
// account only pays for calls anyone may send. With a referee key it also
// referees the timed games that name that key: it stamps their steps and flags
// a seat whose time runs out, which players trust it to do on time.
//
//   node keeper/server.mjs CONFIG_JSON      (see config.example.json)
//
// HTTP API (JSON; BigInts as { "$n": "<decimal>" }, see @referee/sdk/store):
//   POST /games                             { record: session.export() }
//   GET  /games                             archived game ids
//   GET  /games/:channel/:game              { record, start, seq, transcript }
//   GET  /games/:channel/:game/steps        ?from=SEQ&wait=SECONDS (long poll)
//   POST /games/:channel/:game/steps        { from, steps: [{ step, signature, stamp?, attestation? }] }
//   GET  /games/:channel/:game/evidence     equivocation evidence
//   GET  /info, GET /health
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { felt, hex, tag } from '../sdk/src/index.mjs';
import { parse, stringify } from '../sdk/src/store.mjs';
import { fileBackend } from '../sdk/src/store-file.mjs';
import { Archive, KeeperError, fail } from './archive.mjs';
import { ENTRYPOINTS, starknetChain } from './chain.mjs';
import { WAITING, startWatcher } from './watch.mjs';

const DEFAULTS = {
  host: '127.0.0.1', port: 3200, store: 'keeper-data', poll_seconds: 15, settle: true,
  max_games: 10000, max_steps: 4096, max_body_bytes: 1 << 20, rate_per_minute: 120,
  max_wait_seconds: 30, max_waiters: 1000, cors_origin: '*', max_history_steps: 64,
};

const chainTag = id => (/^0x/i.test(id) ? BigInt(id) : tag(id));

/**
 * Resolve a keeper config (a parsed config.example.json). Game codecs are
 * imported from `module` (relative to `base`) and its named `export`.
 */
export async function loadConfig(raw, { base = process.cwd(), env = process.env } = {}) {
  const config = { ...DEFAULTS, ...raw };
  if (!config.chain_id) throw Error('Config needs chain_id');
  if (!Array.isArray(config.games) || config.games.length === 0) throw Error('Config needs at least one entry in games');
  config.chain = chainTag(config.chain_id);
  config.entries = new Map();
  for (const g of config.games) {
    if (!g.channel || !g.module || !g.export) throw Error('Each game needs channel, module and export');
    const url = g.module.startsWith('.') ? pathToFileURL(resolve(base, g.module)).href : g.module;
    const game = (await import(url))[g.export];
    if (!game?.tag) throw Error(`${g.module} exports no game codec named ${g.export}`);
    const channel = felt(g.channel);
    config.entries.set(channel, {
      channel, game, entrypoints: { ...ENTRYPOINTS, ...g.entrypoints },
      max_history_steps: g.max_history_steps ?? config.max_history_steps,
      prover: g.prover ? { url: g.prover.url, class_hash: BigInt(g.prover.class_hash) } : null,
    });
  }
  if (config.referee) {
    const name = config.referee.private_key_env ?? 'KEEPER_REFEREE_KEY';
    const privateKey = env[name];
    if (!privateKey) throw Error(`Set ${name} to the referee's private key`);
    config.referee = { privateKey };
  }
  if (config.account) {
    const privateKey = env[config.account.private_key_env ?? 'KEEPER_PRIVATE_KEY'];
    if (!privateKey) throw Error(`Set ${config.account.private_key_env ?? 'KEEPER_PRIVATE_KEY'} to the keeper account's private key`);
    config.account = { address: config.account.address, privateKey,
      maxFee: config.account.max_fee_fri === undefined ? undefined : BigInt(config.account.max_fee_fri) };
  }
  return config;
}

/**
 * Start a keeper. `backend` defaults to a file store at `config.store`, and
 * `chain` to Starknet at `config.rpc_url` (see keeper/chain.mjs); without
 * either, a keeper archives unverified terms and does not watch, which suits
 * tests only. Returns { url, archive, watcher, close }.
 */
export async function startKeeper(config, { backend, chain, now = Date.now, log = entry => console.log(JSON.stringify(entry)) } = {}) {
  backend ??= await fileBackend(config.store);
  chain ??= config.rpc_url ? starknetChain({ rpcUrl: config.rpc_url, account: config.account }) : null;
  if (chain?.chainId && (await chain.chainId()) !== config.chain) throw Error(`RPC node is not on ${config.chain_id}`);
  const entries = config.entries;
  const archive = await Archive.open(backend, {
    games: [...entries].map(([channel, entry]) => [channel, entry.game]), chainId: config.chain,
    maxSteps: config.max_steps, maxGames: config.max_games, referee: config.referee ?? null, now, log,
    verify: chain && (async session => {
      const channel = await chain.channel(entries.get(felt(session.terms.channel)), session.terms.game_id);
      if (channel.status === WAITING || felt(channel.context) !== session.context) fail(409, 'The terms differ from the channel onchain');
    }),
    anchorHash: chain && (async ids => (await chain.channel(entries.get(ids.channel), ids.game_id)).anchor.hash),
  });
  const watcher = chain && config.poll_seconds > 0
    ? startWatcher({ archive, chain, entries, intervalMs: config.poll_seconds * 1000, settle: config.settle, log })
    : null;

  let waiters = 0;
  const buckets = new Map();
  const admit = client => {
    const now = Date.now(), capacity = config.rate_per_minute;
    const b = buckets.get(client) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * capacity / 60000);
    b.at = now;
    if (b.tokens < 1) fail(429, 'Too many requests; retry later');
    b.tokens -= 1;
    buckets.set(client, b);
  };
  const info = () => ({
    chain_id: config.chain_id, watching: watcher !== null, sending: Boolean(chain?.canSend),
    referee: archive.referee === null ? null : hex(archive.referee),
    games: [...entries.values()].map(e => ({ channel: hex(e.channel), tag: e.game.tag, prover: Boolean(e.prover) })),
    limits: { max_games: config.max_games, max_steps: config.max_steps, max_body_bytes: config.max_body_bytes,
      rate_per_minute: config.rate_per_minute, max_wait_seconds: config.max_wait_seconds },
  });
  const idsOf = (channel, game) => {
    try { return archive.ids(channel, game); } catch { fail(400, 'Invalid game id'); }
  };

  async function handle(method, parts, query, body, res) {
    const [root, channel, game, leaf, ...rest] = parts;
    if (root !== 'games' || rest.length) fail(404, 'Not found');
    if (!channel) {
      if (method === 'POST') return archive.register(body?.record);
      if (method === 'GET') return { games: archive.open().map(ids => ({ channel: hex(ids.channel), game_id: hex(ids.game_id) })) };
      fail(405, 'Method not allowed');
    }
    const ids = idsOf(channel, game);
    if (!leaf && method === 'GET') {
      const session = await archive.session(ids) ?? fail(404, 'Unknown game');
      return { record: session.export(), start: session.start.seq, seq: session.env.seq, transcript: session.env.transcript };
    }
    if (leaf === 'evidence' && method === 'GET') return { evidence: await archive.evidence(ids) };
    if (leaf !== 'steps') fail(404, 'Not found');
    if (method === 'POST') return archive.append(ids, body?.from, body?.steps);
    if (method !== 'GET') fail(405, 'Method not allowed');
    const from = Number(query.get('from') ?? 0), wait = Math.min(Number(query.get('wait') ?? 0), config.max_wait_seconds);
    if (!Number.isSafeInteger(from) || from < 0 || !(wait >= 0)) fail(400, 'Expected ?from=SEQ&wait=SECONDS');
    const result = await archive.steps(ids, from);
    if (result.steps.length || wait === 0) return result;
    if (waiters >= config.max_waiters) fail(503, 'Too many waiting clients; retry later');
    waiters++;
    // Wake once a step at `from` or later exists; a closed response is a client gone.
    const waiter = archive.wait(ids, from, wait * 1000);
    res.once('close', waiter.cancel);
    try { await waiter.promise; } finally { waiters--; res.off('close', waiter.cancel); }
    return archive.steps(ids, from);
  }

  const server = createServer(async (req, res) => {
    const started = Date.now(), client = req.socket.remoteAddress;
    const url = new URL(req.url, 'http://keeper');
    const headers = { 'Access-Control-Allow-Origin': config.cors_origin, 'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    const reply = (status, body) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
      res.end(stringify(body));
      log({ method: req.method, path: url.pathname, status, client, ms: Date.now() - started,
        ...(body?.error ? { error: body.error.message } : {}) });
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200, headers); res.end('ok'); return; }
    try {
      if (req.method === 'GET' && url.pathname === '/info') return reply(200, info());
      let body;
      if (req.method === 'POST') {
        admit(client);
        let text = '', size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > config.max_body_bytes) fail(413, 'Request body too large');
          text += chunk;
        }
        try { body = parse(text); } catch { fail(400, 'Invalid JSON'); }
      }
      reply(200, await handle(req.method, url.pathname.split('/').filter(Boolean), url.searchParams, body, res));
    } catch (e) {
      if (!(e instanceof KeeperError)) console.error(e);
      const status = e instanceof KeeperError ? e.status : 500;
      reply(status, { error: { message: e instanceof KeeperError ? e.message : 'Internal error', ...(e.data !== undefined ? { data: e.data } : {}) } });
    }
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  await new Promise(done => server.listen(config.port, config.host, done));
  const { address, port } = server.address();
  return {
    url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`, archive, watcher, info,
    close: async () => {
      await watcher?.stop();
      archive.stop();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      await backend.close?.();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node keeper/server.mjs CONFIG_JSON'); process.exit(2); }
  const config = await loadConfig(JSON.parse(await readFile(file, 'utf8')), { base: dirname(resolve(file)) });
  const keeper = await startKeeper({ ...config, store: resolve(dirname(resolve(file)), config.store) });
  console.error(`referee keeper on ${keeper.url}: ${JSON.stringify(keeper.info())}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => keeper.close().then(() => process.exit(0)));
}
