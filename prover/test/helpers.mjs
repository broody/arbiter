// Shared by the gateway tests: a mock Starknet node, transactions, assertions,
// and gateways whose workers run mock-backend.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from 'starknet';
import { hex, tag } from '../../sdk/src/index.mjs';
import { rpc } from '../../sdk/src/proving.mjs';
import { patchHashes, startGateway } from '../server.mjs';

export const OS = 0x53f6c9fcfd31d27279ff7d7e422b44623550a732b59fe193354a7316a96daa1n;
export const ADAPTER = 0xad0b7e5n, OTHER = 0xbadn, CLASS = 0xc1a55n;
const OS_PROGRAM = hash.getSelectorFromName('os_program');

export async function listen(handler) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const q = JSON.parse(body);
    const answer = await handler(q);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...answer }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

// A Sepolia node where ADAPTER has CLASS and pins `os`, OTHER has another class,
// and block 999 does not exist.
export function node({ chain = 'SN_SEPOLIA', os = OS, declared = [CLASS] } = {}) {
  return listen(q => {
    const p = q.params;
    switch (q.method) {
      case 'starknet_chainId': return { result: hex(tag(chain)) };
      case 'starknet_getClass':
        return declared.includes(BigInt(p.class_hash)) ? { result: {} } : { error: { code: 28, message: 'Class hash not found' } };
      case 'starknet_getClassHashAt':
        if (p.block_id.block_number === 999) return { error: { code: 24, message: 'Block not found' } };
        if (BigInt(p.contract_address) === ADAPTER) return { result: hex(CLASS) };
        if (BigInt(p.contract_address) === OTHER) return { result: '0x777' };
        return { error: { code: 20, message: 'Contract not found' } };
      case 'starknet_call':
        assert.equal(BigInt(p.request.entry_point_selector), BigInt(OS_PROGRAM));
        return { result: [hex(os)] };
      default: return { error: { code: -32601, message: q.method } };
    }
  });
}

export const tx = (overrides = {}) => ({
  type: 'INVOKE', version: '0x3', sender_address: hex(ADAPTER), calldata: ['0x1', '0x2'], signature: [], nonce: '0x0',
  resource_bounds: { l1_gas: { max_amount: '0x1', max_price_per_unit: '0x0' }, l1_data_gas: { max_amount: '0x1', max_price_per_unit: '0x0' },
    l2_gas: { max_amount: '0x2540be400', max_price_per_unit: '0x0' } },
  tip: '0x0', paymaster_data: [], account_deployment_data: [], nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
  ...overrides,
});
export const prove = (url, params) => rpc(url, 'starknet_proveTransaction', params);
export const code = expected => e => { assert.equal(e.rpcError?.code, expected, JSON.stringify(e.rpcError)); return true; };

/**
 * A build directory whose backend is mock-backend.mjs. `patched` writes a
 * build.json with the current patches' hashes, or `'stale'` with other ones.
 */
export function buildDir({ patched = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arbiter-prover-test-'));
  mkdirSync(join(dir, 'bin'));
  const mock = fileURLToPath(new URL('./mock-backend.mjs', import.meta.url));
  writeFileSync(join(dir, 'bin/starknet_transaction_prover'), `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`, { mode: 0o755 });
  if (patched) writeFileSync(join(dir, 'build.json'), JSON.stringify({ patches: patched === 'stale' ? {} : patchHashes() }));
  return dir;
}

/** A gateway running mock workers (two by default) against a mock node. */
export async function workerGateway({ config = {}, sandbox, patched } = {}) {
  process.env.MOCK_OS_PROGRAM = hex(OS);
  process.env.MOCK_PID_DIR ??= mkdtempSync(join(tmpdir(), 'arbiter-prover-pids-'));
  const n = await node(), logs = [];
  let gateway;
  try {
    gateway = await startGateway({ chain_id: 'SN_SEPOLIA', rpc_url: n.url, port: 0, virtual_os_program: hex(OS),
      adapter_classes: [hex(CLASS)], max_concurrent: 2, build_dir: buildDir({ patched }), ...config,
      workers: { base_port: 20000 + Math.floor(Math.random() * 20000), ...config.workers } }, { log: e => logs.push(e), sandbox });
  } catch (e) { await n.close(); throw e; }
  return { gateway, logs, info: () => rpc(gateway.url, 'arbiter_info', []), close: async () => { await gateway.close(); await n.close(); } };
}

/** Prove with a mock worker; `kind` is the mock's behavior (mock-backend.mjs). */
export const job = (url, kind = '0x1') => prove(url, { block_id: { block_number: 100 }, transaction: tx({ calldata: [kind] }) });

export async function until(check, ms = 10000) {
  for (const deadline = Date.now() + ms; ; await new Promise(r => setTimeout(r, 50))) {
    if (await check()) return;
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${check}`);
  }
}

export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const childPid = () => Number(readFileSync(join(process.env.MOCK_PID_DIR, 'child'), 'utf8'));
