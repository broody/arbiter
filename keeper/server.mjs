// referee keeper: archives and forwards each game's signed steps, and watches
// the channel to answer disputes, resolve them and settle finished games.
//
// A game entry is anchored (the default) when its games open on a channel
// onchain: the keeper checks their terms against it and watches it. An
// unanchored entry keeps games that never touch the chain, such as casual
// ones; each seat's wallet instead signs the terms (`termsTypedData`), which
// the keeper checks against the seat's account contract.
//
// Its trust model is the prover gateway's: it accepts only steps that verify,
// so it cannot forge a move, and both players keep their own copies, so it can
// delay or withhold but not rewrite. It never holds player keys; its own
// account only pays for calls anyone may send. With a referee key it also
// referees the timed games that name that key: it stamps their steps, starts
// their clocks and flags a seat whose time runs out, which players trust it to
// do on time. It registers such games itself when they join onchain.
//
// A game module may export, next to its codec, `admit(ids, terms)`, which
// ranks a new game for the keeper's reserved capacity, and
// `afterSettle(ids, channel)`, which returns calls to send with the resolve
// that settles a game. Each also gets `{ provider }`.
//
//   node keeper/server.mjs CONFIG_JSON      (see config.example.json)
//
// HTTP API (JSON; BigInts as { "$n": "<decimal>" }, see @referee/sdk/store):
//   POST /games                             { record: session.export(), authorizations? }
//   GET  /games                             archived game ids
//   GET  /games/:channel/:game              { record, start, seq, transcript }
//   GET  /games/:channel/:game/steps        ?from=SEQ&wait=SECONDS (long poll)
//   GET  /games/:channel/:game/events       ?from=SEQ (server-sent events: `steps`)
//   POST /games/:channel/:game/steps        { from, steps: [{ step, signature, stamp?, attestation? }] }
//   GET  /games/:channel/:game/evidence     equivocation evidence
//   GET  /info, GET /health
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { felt, hex, tag, termsTypedData } from '../sdk/src/index.mjs';
import { parse, stringify } from '../sdk/src/store.mjs';
import { fileBackend } from '../sdk/src/store-file.mjs';
import { Archive, KeeperError, fail } from './archive.mjs';
import { ENTRYPOINTS, starknetChain } from './chain.mjs';
import { WAITING, startWatcher } from './watch.mjs';

const DEFAULTS = {
  host: '127.0.0.1', port: 3200, store: 'keeper-data', poll_seconds: 15, settle: true,
  max_open_games: 10000, reserved_games: 0, max_open_per_player: 4, unanchored_ttl_seconds: 86400,
  max_steps: 4096, max_body_bytes: 1 << 20, rate_per_minute: 120, max_wait_seconds: 30, max_waiters: 1000,
  cors_origin: '*', replay_max_steps: 64, start_grace_seconds: 120, answer_margin_seconds: 600, heartbeat_seconds: 15,
};

const chainTag = id => (/^0x/i.test(id) ? BigInt(id) : tag(id));

// A game entry's settings, from the config's where it sets none.
// `max_history_steps` is the old name of `replay_max_steps`.
const settings = (g, config) => ({
  max_steps: g.max_steps ?? config.max_steps ?? DEFAULTS.max_steps,
  replay_max_steps: g.replay_max_steps ?? g.max_history_steps ?? config.replay_max_steps ?? config.max_history_steps
    ?? DEFAULTS.replay_max_steps,
  proof_max_steps: g.proof_max_steps ?? config.proof_max_steps ?? null,
  start_grace_seconds: g.start_grace_seconds ?? config.start_grace_seconds ?? DEFAULTS.start_grace_seconds,
  answer_margin_seconds: g.answer_margin_seconds ?? config.answer_margin_seconds ?? DEFAULTS.answer_margin_seconds,
});

/**
 * Resolve a keeper config (a parsed config.example.json). Game codecs are
 * imported from `module` (relative to `base`) and its named `export`.
 */
export async function loadConfig(raw, { base = process.cwd(), env = process.env } = {}) {
  const config = { ...DEFAULTS, ...raw };
  // Old names: `max_games`, `max_history_steps`.
  config.max_open_games = raw.max_open_games ?? raw.max_games ?? DEFAULTS.max_open_games;
  config.replay_max_steps = raw.replay_max_steps ?? raw.max_history_steps ?? DEFAULTS.replay_max_steps;
  if (!config.chain_id) throw Error('Config needs chain_id');
  if (!Array.isArray(config.games) || config.games.length === 0) throw Error('Config needs at least one entry in games');
  config.chain = chainTag(config.chain_id);
  config.entries = new Map();
  for (const g of config.games) {
    if (!g.channel || !g.module || !g.export) throw Error('Each game needs channel, module and export');
    const url = g.module.startsWith('.') ? pathToFileURL(resolve(base, g.module)).href : g.module;
    const module = await import(url), game = module[g.export];
    if (!game?.tag) throw Error(`${g.module} exports no game codec named ${g.export}`);
    if (typeof game.maxSteps !== 'function') throw Error(`${g.export} has no maxSteps: it predates protocol v4`);
    const channel = felt(g.channel), anchored = g.anchored ?? true;
    if (!anchored && g.prover) throw Error('An unanchored game has no channel to settle on: remove its prover');
    if (g.world && !g.namespace) throw Error('A game entry with a world needs its namespace');
    const hook = name => (typeof module[name] === 'function' ? module[name] : null);
    config.entries.set(channel, {
      channel, game, anchored, entrypoints: { ...ENTRYPOINTS, ...g.entrypoints }, ...settings(g, config),
      world: anchored && g.world ? felt(g.world) : null, namespace: g.namespace ?? null, from_block: g.from_block ?? null,
      admit: hook('admit'), afterSettle: hook('afterSettle'),
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
 * Check that each seat's wallet signed an unanchored game's terms: one
 * signature per player, in seat order, valid for `termsTypedData`.
 */
async function verifyAuthorizations(chain, game, terms, authorizations) {
  if (!Array.isArray(authorizations) || authorizations.length !== terms.players.length)
    fail(403, 'An unanchored game needs each seat\'s wallet signature over its terms');
  const typedData = termsTypedData(game, terms);
  for (const [seat, player] of terms.players.entries()) {
    let valid = false;
    try { valid = await chain.verifyMessage(player, typedData, authorizations[seat]); } catch {}
    if (!valid) fail(403, `Seat ${seat}'s wallet did not sign these terms`);
  }
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
  // The game modules' hooks get the RPC provider too.
  const context = { provider: chain?.provider };
  const entries = new Map([...config.entries].map(([channel, e]) => [channel, {
    anchored: true, ...e, ...settings(e, config),
    admit: e.admit ? (ids, terms) => e.admit(ids, terms, context) : null,
    afterSettle: e.afterSettle ? (ids, channel) => e.afterSettle(ids, channel, context) : null,
  }]));
  const archive = await Archive.open(backend, {
    games: [...entries].map(([channel, e]) => [channel, { game: e.game, anchored: e.anchored, maxSteps: e.max_steps,
      startGraceMs: e.start_grace_seconds * 1000, admit: e.admit }]),
    chainId: config.chain, maxSteps: config.max_steps ?? DEFAULTS.max_steps,
    maxOpenGames: config.max_open_games ?? config.max_games ?? DEFAULTS.max_open_games,
    reservedGames: config.reserved_games ?? 0, maxOpenPerPlayer: config.max_open_per_player ?? DEFAULTS.max_open_per_player,
    unanchoredTtlMs: (config.unanchored_ttl_seconds ?? DEFAULTS.unanchored_ttl_seconds) * 1000,
    referee: config.referee ?? null, now, log,
    verify: chain && (async (session, authorizations) => {
      const entry = entries.get(felt(session.terms.channel));
      if (!entry.anchored) return verifyAuthorizations(chain, entry.game, session.terms, authorizations);
      const channel = await chain.channel(entry, session.terms.game_id);
      if (channel.status === WAITING || felt(channel.context) !== session.context) fail(409, 'The terms differ from the channel onchain');
    }),
    anchorHash: chain && (async ids => {
      const entry = entries.get(ids.channel);
      return entry.anchored ? (await chain.channel(entry, ids.game_id)).anchor.hash : null;
    }),
  });
  const watcher = chain && config.poll_seconds > 0
    ? startWatcher({ archive, chain, entries, intervalMs: config.poll_seconds * 1000, settle: config.settle, log })
    : null;
  // Idle unanchored games close after their time to live.
  const sweeping = [...entries.values()].some(e => !e.anchored)
    ? setInterval(() => archive.sweep().catch(e => log({ event: 'sweep', outcome: 'failed', error: e.message })), 60_000)
    : null;
  sweeping?.unref?.();

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
    games: [...entries.values()].map(e => ({ channel: hex(e.channel), tag: e.game.tag, anchored: e.anchored, prover: Boolean(e.prover) })),
    limits: { max_open_games: archive.maxOpenGames, reserved_games: archive.reservedGames,
      max_open_per_player: archive.maxOpenPerPlayer, max_steps: config.max_steps, max_body_bytes: config.max_body_bytes,
      rate_per_minute: config.rate_per_minute, max_wait_seconds: config.max_wait_seconds, max_waiters: config.max_waiters },
    // What a matchmaker checks before it pairs a game here.
    capacity: archive.capacity(),
  });
  const idsOf = (channel, game) => {
    try { return archive.ids(channel, game); } catch { fail(400, 'Invalid game id'); }
  };

  async function handle(method, parts, query, body, res) {
    const [root, channel, game, leaf, ...rest] = parts;
    if (root !== 'games' || rest.length) fail(404, 'Not found');
    if (!channel) {
      if (method === 'POST') return archive.register(body?.record, body?.authorizations);
      if (method === 'GET') return { games: archive.open().map(ids => ({ channel: hex(ids.channel), game_id: hex(ids.game_id) })) };
      fail(405, 'Method not allowed');
    }
    const ids = idsOf(channel, game);
    if (!leaf && method === 'GET') {
      const session = await archive.session(ids) ?? fail(404, 'Unknown game');
      const authorizations = await archive.authorizations(ids);
      return { record: session.export(), start: session.start.seq, seq: session.env.seq, transcript: session.env.transcript,
        ...(authorizations ? { authorizations } : {}) };
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

  // Server-sent events: each batch of steps from `from` on, as the archive
  // gets it, with a comment line every `heartbeat_seconds` to keep proxies
  // from closing an idle stream. A stream counts as a waiting client.
  async function stream(ids, query, res, headers, done) {
    const from = Number(query.get('from') ?? 0);
    if (!Number.isSafeInteger(from) || from < 0) fail(400, 'Expected ?from=SEQ');
    await archive.session(ids) ?? fail(404, 'Unknown game');
    if (waiters >= config.max_waiters) fail(503, 'Too many waiting clients; retry later');
    waiters++;
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let sent = from, tail = Promise.resolve();
    const push = () => {
      tail = tail.then(async () => {
        const result = await archive.steps(ids, sent);
        if (!result.steps.length || res.writableEnded) return;
        res.write(`event: steps\ndata: ${stringify(result)}\n\n`);
        sent = result.seq;
      }).catch(e => log({ event: 'stream', error: e.message }));
    };
    const unsubscribe = archive.subscribe(ids, push);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), config.heartbeat_seconds * 1000);
    heartbeat.unref?.();
    res.once('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      waiters--;
      done();
    });
    push();
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
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && parts.length === 4 && parts[0] === 'games' && parts[3] === 'events') {
        return await stream(idsOf(parts[1], parts[2]), url.searchParams, res, headers, () =>
          log({ method: req.method, path: url.pathname, status: 200, client, ms: Date.now() - started, stream: true }));
      }
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
      reply(200, await handle(req.method, parts, url.searchParams, body, res));
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
      clearInterval(sweeping);
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
