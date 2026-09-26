// referee prover gateway: a `starknet_proveTransaction` JSON-RPC endpoint (the
// API `@referee/sdk/proving` calls) in front of a proving backend, today
// StarkWare's starknet_transaction_prover built by build.sh (PROOF1).
//
// Before a request takes a proving slot, the gateway checks that it is the
// zero-fee virtual INVOKE_V3 of an allowlisted referee adapter class whose
// pinned virtual OS program is the backend's. So a public server proves referee
// settlements and nothing else. It never sees session keys: transcripts and
// signatures are public.
//
//   node prover/server.mjs CONFIG_JSON      (see config.example.json)
//
// Methods: starknet_specVersion, starknet_proveTransaction, referee_info.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hash } from 'starknet';
import { hex, tag } from '../sdk/src/index.mjs';
import { rpc } from '../sdk/src/proving.mjs';

// JSON-RPC error codes: the proving API's where one fits, then referee's own.
export const INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL = -32603;
export const SERVICE_BUSY = -32005, RATE_LIMITED = -32029;
export const BLOCK_NOT_FOUND = 24, INVALID_TRANSACTION = 1000;
export const NOT_ALLOWED = 1100, WRONG_OS_PROGRAM = 1101, EXCEEDS_PROOF1 = 1102;

// The adapter's pinned virtual OS program getter (referee_adapter `os_program`).
const OS_PROGRAM_SELECTOR = hash.getSelectorFromName('os_program');

const DEFAULTS = {
  host: '127.0.0.1', port: 3100, max_concurrent: 1, max_queued: 8, max_calldata: 20000,
  max_body_bytes: 1 << 20, rate_per_minute: 12, backend_timeout_ms: 600000,
};

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const fail = (code, message, data) => { throw new RpcError(code, message, data); };
const isFelt = v => typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v);
const big = v => { try { return BigInt(v); } catch { return null; } };
const zero = v => big(v) === 0n;

/** Resolve and validate a gateway config (a parsed config.example.json). */
export function loadConfig(raw) {
  const config = { ...DEFAULTS, ...raw };
  for (const key of ['rpc_url', 'backend_url', 'chain_id', 'virtual_os_program'])
    if (!config[key]) throw Error(`Config needs ${key}`);
  if (!Array.isArray(config.adapter_classes) || config.adapter_classes.length === 0)
    throw Error('Config needs at least one adapter class in adapter_classes');
  config.adapter_classes = new Set(config.adapter_classes.map(c => BigInt(c)));
  config.virtual_os_program = BigInt(config.virtual_os_program);
  return config;
}

// Shape checks that need no chain access. The backend repeats its own.
function checkTransaction(params, config) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail(INVALID_PARAMS, 'Expected named params { block_id, transaction }');
  const { block_id: block, transaction: tx } = params;
  if (!block || typeof block !== 'object' || !(isFelt(block.block_hash) || Number.isSafeInteger(block.block_number)))
    fail(INVALID_PARAMS, 'block_id must be { block_hash } or { block_number } of a finalized block');
  if (!tx || tx.type !== 'INVOKE' || big(tx.version) !== 3n) fail(INVALID_TRANSACTION, 'Only INVOKE_V3 transactions are proved');
  if (!isFelt(tx.sender_address)) fail(INVALID_TRANSACTION, 'Invalid sender_address');
  if (!Array.isArray(tx.calldata) || !tx.calldata.every(isFelt)) fail(INVALID_TRANSACTION, 'Invalid calldata');
  if (tx.calldata.length > config.max_calldata) fail(INVALID_TRANSACTION, `Calldata exceeds ${config.max_calldata} felts; settle in checkpoints`);
  const bounds = tx.resource_bounds ?? {};
  if (!zero(tx.tip) || !['l1_gas', 'l1_data_gas', 'l2_gas'].every(k => zero(bounds[k]?.max_price_per_unit)))
    fail(INVALID_TRANSACTION, 'Proving transactions are virtual: tip and gas prices must be zero');
  if ((tx.paymaster_data ?? []).length || (tx.account_deployment_data ?? []).length) fail(INVALID_TRANSACTION, 'Unexpected paymaster or deployment data');
  return { block, tx };
}

/**
 * Start a gateway. Returns { url, close, info }. `log` receives one object per
 * finished request.
 */
export async function startGateway(rawConfig, { log = entry => console.log(JSON.stringify(entry)) } = {}) {
  const config = loadConfig(rawConfig);
  const node = (method, params) => rpc(config.rpc_url, method, params);

  // Startup checks: the node is on the configured chain, the backend answers,
  // and every allowlisted adapter class is declared.
  const chain = BigInt(await node('starknet_chainId'));
  if (chain !== tag(config.chain_id)) throw Error(`RPC node is on ${hex(chain)}, not ${config.chain_id}`);
  const backendVersion = await rpc(config.backend_url, 'starknet_specVersion', []);
  for (const classHash of config.adapter_classes) {
    try { await node('starknet_getClass', { block_id: 'latest', class_hash: hex(classHash) }); }
    catch (e) { throw Error(`Adapter class ${hex(classHash)} is not declared: ${e.message}`); }
  }

  let running = 0, jobs = 0;
  const waiting = [];
  const buckets = new Map();
  const acquire = () => {
    if (running < config.max_concurrent) { running++; return Promise.resolve(); }
    if (waiting.length >= config.max_queued) fail(SERVICE_BUSY, 'Service busy: proving queue is full; retry later');
    return new Promise(resolve => waiting.push(resolve));
  };
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
  const admit = client => {
    const now = Date.now(), capacity = config.rate_per_minute;
    const b = buckets.get(client) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * capacity / 60000); b.at = now;
    if (b.tokens < 1) fail(RATE_LIMITED, 'Too many proving requests; retry later');
    b.tokens -= 1; buckets.set(client, b);
  };

  const info = () => ({
    chain_id: config.chain_id, virtual_os_program: hex(config.virtual_os_program),
    adapter_classes: [...config.adapter_classes].map(hex), proof_paths: ['PROOF1'], backend_spec_version: backendVersion,
    limits: { max_concurrent: config.max_concurrent, max_queued: config.max_queued, max_calldata: config.max_calldata,
      rate_per_minute: config.rate_per_minute },
  });

  async function prove(params, client) {
    const { block, tx } = checkTransaction(params, config);
    admit(client);
    let classHash;
    try { classHash = BigInt(await node('starknet_getClassHashAt', { block_id: block, contract_address: tx.sender_address })); }
    catch (e) {
      if (e.rpcError?.code === 24) fail(BLOCK_NOT_FOUND, 'Block not found');
      if (e.rpcError?.code === 20) fail(NOT_ALLOWED, 'Sender is not a deployed contract');
      throw e;
    }
    if (!config.adapter_classes.has(classHash)) fail(NOT_ALLOWED, 'Sender is not an allowlisted referee adapter', { class_hash: hex(classHash) });
    const [osProgram] = await node('starknet_call', { block_id: block,
      request: { contract_address: tx.sender_address, entry_point_selector: OS_PROGRAM_SELECTOR, calldata: [] } });
    if (BigInt(osProgram) !== config.virtual_os_program)
      fail(WRONG_OS_PROGRAM, 'Adapter pins another virtual OS program; its proofs could not settle', { os_program: osProgram });
    await acquire();
    try {
      const result = await rpc(config.backend_url, 'starknet_proveTransaction', params, config.backend_timeout_ms);
      if (big(result.proof_facts?.[2]) !== config.virtual_os_program) fail(INTERNAL, 'Backend proved with another virtual OS program');
      return { result, classHash };
    } catch (e) {
      if (e.rpcError) {
        const detail = `${e.rpcError.message} ${JSON.stringify(e.rpcError.data ?? '')}`;
        if (detail.includes('Not enough twiddles')) fail(EXCEEDS_PROOF1, 'Transaction exceeds PROOF1 capacity; settle in checkpoints', e.rpcError);
        fail(e.rpcError.code, e.rpcError.message, e.rpcError.data);
      }
      throw e;
    } finally { release(); }
  }

  async function handle(request, client) {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') fail(INVALID_REQUEST, 'Invalid JSON-RPC request');
    switch (request.method) {
      case 'starknet_specVersion': return { result: backendVersion };
      case 'referee_info': return { result: info() };
      case 'starknet_proveTransaction': {
        const id = ++jobs, started = Date.now();
        const entry = { job: id, client, sender: request.params?.transaction?.sender_address,
          block: request.params?.block_id, calldata: request.params?.transaction?.calldata?.length };
        try {
          const { result, classHash } = await prove(request.params, client);
          log({ ...entry, class_hash: hex(classHash), outcome: 'proved', ms: Date.now() - started,
            proof_version: result.proof_facts?.[0] });
          return { result };
        } catch (e) {
          log({ ...entry, outcome: 'refused', code: e.code ?? INTERNAL, error: e.message, ms: Date.now() - started });
          throw e;
        }
      }
      default: fail(METHOD_NOT_FOUND, `Unknown method ${request.method}`);
    }
  }

  const server = createServer(async (req, res) => {
    const reply = (id, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, ...body })); };
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '', size = 0, id = null;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > config.max_body_bytes) fail(INVALID_REQUEST, 'Request body too large');
        body += chunk;
      }
      let request;
      try { request = JSON.parse(body); } catch { fail(-32700, 'Parse error'); }
      id = request?.id ?? null;
      reply(id, await handle(request, req.socket.remoteAddress));
    } catch (e) {
      const code = e instanceof RpcError ? e.code : INTERNAL;
      reply(id, { error: { code, message: e instanceof RpcError ? e.message : 'Internal error', ...(e.data !== undefined ? { data: e.data } : {}) } });
      if (!(e instanceof RpcError)) console.error(e);
    }
  });
  // Proofs take seconds to minutes; keep idle client connections open past Node's 5 s default.
  server.keepAliveTimeout = 65000; server.headersTimeout = 66000; server.requestTimeout = config.backend_timeout_ms + 60000;
  await new Promise(resolve => server.listen(config.port, config.host, resolve));
  const { address, port } = server.address();
  return { url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`, info,
    close: () => new Promise(resolve => server.close(resolve)) };
}


if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node prover/server.mjs CONFIG_JSON'); process.exit(2); }
  const gateway = await startGateway(JSON.parse(await readFile(file, 'utf8')));
  console.error(`referee prover gateway on ${gateway.url}: ${JSON.stringify(gateway.info())}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => gateway.close().then(() => process.exit(0)));
}
