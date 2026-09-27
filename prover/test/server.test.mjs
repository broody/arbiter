// The prover gateway against a mock RPC node and a mock proving backend: only
// allowlisted adapters with the pinned OS program reach the backend. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hex, tag } from '../../sdk/src/index.mjs';
import { rpc } from '../../sdk/src/proving.mjs';
import {
  BLOCK_NOT_FOUND, EXCEEDS_PROOF1, INVALID_PARAMS, INVALID_TRANSACTION, METHOD_NOT_FOUND, NOT_ALLOWED, RATE_LIMITED,
  SERVICE_BUSY, WRONG_OS_PROGRAM, loadConfig, startGateway,
} from '../server.mjs';
import { ADAPTER, CLASS, OS, OTHER, code, listen, node, prove, tx } from './helpers.mjs';

const proofResult = { proof: 'b64', proof_facts: [hex(tag('PROOF1')), hex(tag('VIRTUAL_SNOS')), hex(OS)], l2_to_l1_messages: [] };
function backend({ answer = () => ({ result: proofResult }), delay = 0 } = {}) {
  const calls = [];
  return listen(async q => {
    if (q.method === 'starknet_specVersion') return { result: '0.10.3-rc.2' };
    calls.push(q);
    await new Promise(r => setTimeout(r, delay));
    return answer(q);
  }).then(s => ({ ...s, calls }));
}

async function setup(options = {}) {
  const n = await node(options.node), b = await backend(options.backend), logs = [];
  const gateway = await startGateway({ chain_id: 'SN_SEPOLIA', rpc_url: n.url, backend_url: b.url, port: 0,
    virtual_os_program: hex(OS), adapter_classes: [hex(CLASS)], ...options.config }, { log: e => logs.push(e) });
  return { gateway, backend: b, logs, close: async () => { await gateway.close(); await n.close(); await b.close(); } };
}

test('an allowlisted adapter reaches the backend and gets its proof', async () => {
  const s = await setup();
  try {
    const params = { block_id: { block_hash: '0x456' }, transaction: tx() };
    assert.deepEqual(await prove(s.gateway.url, params), proofResult);
    assert.equal(s.backend.calls.length, 1);
    assert.deepEqual(s.backend.calls[0].params, params);
    assert.equal(await rpc(s.gateway.url, 'starknet_specVersion', []), '0.10.3-rc.2');
    const info = await rpc(s.gateway.url, 'referee_info', []);
    assert.deepEqual(info.adapter_classes, [hex(CLASS)]);
    assert.deepEqual(info.proof_paths, ['PROOF1']);
    assert.equal(info.memory, 'standard');
    assert.equal(s.logs.at(-1).outcome, 'proved');
  } finally { await s.close(); }
});

test('everything else is refused before it takes a proving slot', async () => {
  const s = await setup();
  try {
    const block = { block_number: 100 };
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: tx({ sender_address: hex(OTHER) }) }), code(NOT_ALLOWED));
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: tx({ sender_address: '0x999' }) }), code(NOT_ALLOWED));
    await assert.rejects(prove(s.gateway.url, { block_id: { block_number: 999 }, transaction: tx() }), code(BLOCK_NOT_FOUND));
    await assert.rejects(prove(s.gateway.url, { block_id: 'latest', transaction: tx() }), code(INVALID_PARAMS));
    await assert.rejects(prove(s.gateway.url, [block, tx()]), code(INVALID_PARAMS));
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: tx({ tip: '0x1' }) }), code(INVALID_TRANSACTION));
    const priced = tx(); priced.resource_bounds.l2_gas.max_price_per_unit = '0x1';
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: priced }), code(INVALID_TRANSACTION));
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: tx({ version: '0x1' }) }), code(INVALID_TRANSACTION));
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: tx({ type: 'DECLARE' }) }), code(INVALID_TRANSACTION));
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: tx({ calldata: ['xyz'] }) }), code(INVALID_TRANSACTION));
    await assert.rejects(prove(s.gateway.url, { block_id: block, transaction: tx({ paymaster_data: ['0x1'] }) }), code(INVALID_TRANSACTION));
    await assert.rejects(rpc(s.gateway.url, 'starknet_call', {}), code(METHOD_NOT_FOUND));
    assert.equal(s.backend.calls.length, 0);
    assert(s.logs.every(e => e.outcome === 'refused'));
  } finally { await s.close(); }
});

test('an adapter pinning another OS program is refused', async () => {
  const s = await setup({ node: { os: OS + 1n } });
  try {
    await assert.rejects(prove(s.gateway.url, { block_id: { block_number: 100 }, transaction: tx() }), code(WRONG_OS_PROGRAM));
    assert.equal(s.backend.calls.length, 0);
  } finally { await s.close(); }
});

test('oversized calldata and PROOF1 overflow ask for checkpoints', async () => {
  const s = await setup({ config: { max_calldata: 2 },
    backend: { answer: () => ({ error: { code: -32603, message: 'Internal error', data: 'proving failed: Not enough twiddles!' } }) } });
  try {
    await assert.rejects(prove(s.gateway.url, { block_id: { block_number: 100 }, transaction: tx({ calldata: ['0x1', '0x2', '0x3'] }) }),
      e => e.rpcError?.code === INVALID_TRANSACTION && /checkpoints/.test(e.rpcError.message));
    await assert.rejects(prove(s.gateway.url, { block_id: { block_number: 100 }, transaction: tx() }),
      e => e.rpcError?.code === EXCEEDS_PROOF1 && /PROOF1/.test(e.rpcError.message));
  } finally { await s.close(); }
});

test('backend errors pass through unchanged', async () => {
  const s = await setup({ backend: { answer: () => ({ error: { code: 55, message: 'Account validation failed', data: 'boom' } }) } });
  try {
    await assert.rejects(prove(s.gateway.url, { block_id: { block_number: 100 }, transaction: tx() }),
      e => e.rpcError?.code === 55 && e.rpcError.data === 'boom');
  } finally { await s.close(); }
});

test('a full queue answers busy and every slot is released', async () => {
  const s = await setup({ config: { max_concurrent: 1, max_queued: 1 }, backend: { delay: 150 } });
  try {
    const params = { block_id: { block_number: 100 }, transaction: tx() };
    const results = await Promise.allSettled([prove(s.gateway.url, params), prove(s.gateway.url, params), prove(s.gateway.url, params)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(results.find(r => r.status === 'rejected').reason.rpcError.code, SERVICE_BUSY);
    assert.deepEqual(await prove(s.gateway.url, params), proofResult);
  } finally { await s.close(); }
});

test('clients are rate limited', async () => {
  const s = await setup({ config: { rate_per_minute: 2 } });
  try {
    const params = { block_id: { block_number: 100 }, transaction: tx() };
    await prove(s.gateway.url, params); await prove(s.gateway.url, params);
    await assert.rejects(prove(s.gateway.url, params), code(RATE_LIMITED));
  } finally { await s.close(); }
});

test('the memory mode must be one the backend has', () => {
  const base = { rpc_url: 'http://node', backend_url: 'http://backend', chain_id: 'SN_SEPOLIA',
    virtual_os_program: hex(OS), adapter_classes: [hex(CLASS)] };
  assert.equal(loadConfig(base).memory, 'standard');
  assert.equal(loadConfig({ ...base, memory: 'bounded' }).memory, 'bounded');
  assert.throws(() => loadConfig({ ...base, memory: 'tiny' }), /memory must be one of standard, bounded/);
  assert.throws(() => loadConfig({ ...base, memory: 'toString' }), /memory must be one of/);
});

test('startup refuses the wrong chain or an undeclared adapter class', async () => {
  for (const [nodeOptions, message] of [[{ chain: 'SN_MAIN' }, /not SN_SEPOLIA/], [{ declared: [] }, /not declared/]]) {
    const n = await node(nodeOptions), b = await backend();
    try {
      await assert.rejects(startGateway({ chain_id: 'SN_SEPOLIA', rpc_url: n.url, backend_url: b.url, port: 0,
        virtual_os_program: hex(OS), adapter_classes: [hex(CLASS)] }, { log: () => {} }), message);
    } finally { await n.close(); await b.close(); }
  }
  await assert.rejects(startGateway({ chain_id: 'SN_SEPOLIA', rpc_url: 'x', backend_url: 'y', virtual_os_program: '0x1', adapter_classes: [] }),
    /adapter class/);
});
