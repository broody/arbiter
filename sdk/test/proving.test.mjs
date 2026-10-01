// Native proving client over the counter game: calldata layouts the adapter
// expects, response checks, and a full proveSession against a fake RPC
// provider and a local prover. No network access.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ec, typedData } from 'starknet';
import {
  Session, ZERO_SIGNATURE, contextHash, encodeEnvelope, encodeSignatures, encodeSteps, encodeTerms, encodeWitness,
  hex, play, proofMessageHash, proofPayload, publicKey, sign, stateHash, tag, termsMessageHash, termsTypedData,
} from '../src/index.mjs';
import {
  VIRTUAL_OS_PROGRAM, getChannel, getSnapshot, historyCall, nativeProofBlock, openGameCall, proveSession, provingCalldata,
  provingTransaction, reverted, settlementCall, snapshotIfOpen, validateNativeProof,
} from '../src/proving.mjs';
import { ADD, counter } from '../examples/counter.mjs';

const keys = [0x1n, 0x2n];
const CHAIN = tag('SN_TEST');
const terms = {
  chain_id: CHAIN, channel: 0xc4a11e1n, game_id: 7n, prover: 0xad0b7e5n, response_seconds: 3600,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: [0x11n, 0x22n], config: { target: 20 },
};
const CLASS = 0xc1a55n, OS = BigInt(VIRTUAL_OS_PROGRAM);
const block = { block_number: 123, block_hash: '0x456' };

function played() {
  const session = new Session(counter, terms);
  session.move(play({ kind: ADD, amount: 3 }), keys[0]);
  session.move(play({ kind: ADD, amount: 2 }), keys[1]);
  session.move(play({ kind: ADD, amount: 1 }), keys[0]);
  return session;
}
const session = played();
const startHash = stateHash(counter, session.start), endHash = session.stateHash();
const expected = { classHash: CLASS, terms, epoch: 0, startHash, endHash, block, osProgram: OS };

function response(overrides = {}) {
  const t = { ...expected, ...overrides };
  const payload = proofPayload(counter, { classHash: t.classHash, prover: terms.prover, terms,
    context: contextHash(counter, terms), epoch: t.epoch, startHash: t.startHash, endHash: t.endHash });
  return { proof: 'opaque-test-response-not-a-real-proof',
    l2_to_l1_messages: [{ from_address: hex(terms.prover), to_address: '0x0', payload: payload.map(hex) }],
    proof_facts: [tag('PROOF1'), tag('VIRTUAL_SNOS'), OS, tag('VIRTUAL_SNOS0'), BigInt(t.block.block_number),
      BigInt(t.block.block_hash), 9n, 1n, proofMessageHash(terms.prover, payload)].map(hex) };
}

test('proof bases are ten blocks deep and never predate the anchor', () => {
  assert.equal(nativeProofBlock(100, 90), 90);
  assert.equal(nativeProofBlock(100, 91), null);
  assert.equal(nativeProofBlock(9, 0), null);
  assert.equal(nativeProofBlock(101, 90), 91);
  assert.throws(() => nativeProofBlock(100, -1), /Invalid block number/);
});

test('proving calldata is the adapter __execute__ layout with final signatures only', () => {
  const calldata = provingCalldata(session, 2);
  const envelope = encodeEnvelope(counter, session.start);
  const signatures = [session.steps[2].signature, session.steps[1].signature];
  // An untimed batch: no stamps, the final signatures and a zero attestation.
  assert.deepEqual(calldata, [terms.channel, terms.game_id, 2n, ...envelope,
    ...encodeSteps(counter, session.steps.map(s => s.step)), 0n, ...encodeSignatures(signatures), 0n, 0n, 1n]);
  const tx = provingTransaction({ session, epoch: 2, nonce: 5 });
  assert.deepEqual(tx.calldata, calldata.map(hex));
  assert.equal(BigInt(tx.sender_address), terms.prover);
  assert.equal(tx.nonce, '0x5');
  assert.equal(tx.resource_bounds.l2_gas.max_price_per_unit, '0x0');
  // `None` for a game the channel holds; `Some(terms)` for one it hasn't opened.
  assert.deepEqual(calldata.slice(-1), [1n]);
  const opening = provingCalldata(session, 0, { opening: true });
  assert.deepEqual(opening.slice(calldata.length - 1), [0n, ...encodeTerms(counter, terms)]);
});

test('open_game takes the terms, every wallet signature and the referee\'s', () => {
  const signatures = [[1n, 2n], [3n, 4n, 5n]];
  const call = openGameCall(counter, terms, signatures);
  assert.equal(BigInt(call.contractAddress), terms.channel);
  assert.equal(call.entrypoint, 'open_game');
  assert.deepEqual(call.calldata.map(BigInt), [...encodeTerms(counter, terms), 2n, 2n, 1n, 2n, 3n, 3n, 4n, 5n, 0n, 0n]);
  const tipped = openGameCall(counter, terms, signatures, { refereeSignature: { r: 7n, s: 8n }, entrypoint: 'open' });
  assert.deepEqual([tipped.entrypoint, ...tipped.calldata.slice(-2).map(BigInt)], ['open', 7n, 8n]);
});

test('a wallet signs the terms message the channel checks', () => {
  const key = '0x5eed1', account = 0xa11cen;
  const hash = termsMessageHash(counter, terms, account);
  assert.equal(hash, BigInt(typedData.getMessageHash(termsTypedData(counter, terms), hex(account))));
  // Another account, game or set of terms signs another message.
  assert.notEqual(termsMessageHash(counter, terms, 0xb0bn), hash);
  assert.notEqual(termsMessageHash(counter, { ...terms, game_id: 8n }, account), hash);
  assert.notEqual(termsMessageHash(counter, { ...terms, config: { target: 21 } }, account), hash);
  const signature = ec.starkCurve.sign(hex(hash), key);
  assert(ec.starkCurve.verify(signature, hex(hash), ec.starkCurve.getPublicKey(key)));
});

test('submit_history replays from the start against final signatures', async () => {
  const signatures = [session.steps[2].signature, session.steps[1].signature];
  const call = historyCall(session, 4);
  assert.deepEqual([call.contractAddress, call.entrypoint], [hex(terms.channel), 'submit_history']);
  assert.deepEqual(call.calldata.map(BigInt), [terms.game_id, 4n, ...encodeEnvelope(counter, session.start),
    ...encodeSteps(counter, session.steps.map(s => s.step)), 0n, ...encodeSignatures(signatures), 0n, 0n,
    ...encodeSignatures([ZERO_SIGNATURE, ZERO_SIGNATURE])]);
  assert.equal(historyCall(session, 4, { entrypoint: 'submit' }).entrypoint, 'submit');

  const ref = [0x11n, 5n, 3n, 1n, 0n, 0n, 0n];
  const stored = [terms.game_id, 0xa11cen, 0xb0bn, 1n, 2n, 3n, 4n, terms.prover, 1n, 20n, 2n, 3n, 0xc0n, 3600n, 0n, 0n,
    0n, ...ref, ...ref, 55n, 55n, 900n, 0n, 0n, 0n, 0n, 0n];
  const provider = { callContract: async (c, block) => {
    assert.deepEqual([c.contractAddress, c.entrypoint, c.calldata, block], [hex(terms.channel), 'get_channel', [hex(terms.game_id)], 'latest']);
    return stored.map(hex);
  } };
  const channel = await getChannel(provider, counter, terms.channel, terms.game_id);
  assert.deepEqual([channel.status, channel.epoch, channel.deadline, channel.anchor.seq], [2, 3, 900, 5]);
});

test('games with a replay witness must encode it', () => {
  assert.deepEqual(encodeWitness(counter, null), []);
  assert.deepEqual(encodeWitness({ ...counter, load: () => null, encodeWitness: w => [BigInt(w.length), ...w] }, [5n]), [1n, 5n]);
  assert.throws(() => encodeWitness({ ...counter, load: () => null }, [5n]), /encodeWitness/);
});

test('settlement calls the adapter with the end state and approvals', () => {
  const call = settlementCall(counter, { prover: terms.prover, channel: terms.channel, gameId: terms.game_id, epoch: 1,
    startHash, end: session.env });
  assert.equal(call.entrypoint, 'settle');
  assert.equal(BigInt(call.contractAddress), terms.prover);
  assert.deepEqual(call.calldata.map(BigInt), [terms.channel, terms.game_id, 1n, startHash, ...encodeEnvelope(counter, session.env),
    ...encodeSignatures([ZERO_SIGNATURE, ZERO_SIGNATURE])]);
});

test('native responses must carry exactly the requested transition', () => {
  assert.equal(validateNativeProof(counter, response(), expected).proof, response().proof);
  const large = response(); large.proof_facts[0] = hex(tag('PROOF2'));
  assert.equal(validateNativeProof(counter, large, expected).proofFacts, large.proof_facts);
  assert.throws(() => validateNativeProof(counter, response(), { ...expected, osProgram: undefined }), /OS program/);
  for (const mutate of [r => r.proof = '', r => r.l2_to_l1_messages.push(r.l2_to_l1_messages[0]),
    r => r.l2_to_l1_messages[0].from_address = '0x7', r => r.l2_to_l1_messages[0].to_address = '0x1',
    r => r.l2_to_l1_messages[0].payload[9] = '0x1', r => r.proof_facts[0] = hex(tag('PROOF3')),
    r => r.proof_facts[2] = '0x9', r => r.proof_facts[4] = '0x7a', r => r.proof_facts[5] = '0x457',
    r => r.proof_facts[7] = '0x2', r => r.proof_facts[8] = '0x1', r => r.proof_facts.push('0x0')]) {
    const r = response(); mutate(r);
    assert.throws(() => validateNativeProof(counter, r, expected));
  }
  for (const changed of [{ terms: { ...terms, game_id: 8n } }, { epoch: 1 }, { classHash: CLASS + 1n },
    { endHash: endHash + 1n }, { startHash: endHash }, { osProgram: OS + 1n }])
    assert.throws(() => validateNativeProof(counter, response(), { ...expected, ...changed }));
  assert.throws(() => validateNativeProof({ ...counter, tag: 'OTHER' }, response(), expected), /another transition/);
});

// A provider for one channel whose anchor is the session start at block 100,
// and whose candidate is the anchor unless given.
function fakeProvider({ head = 140, anchorBlock = 100, epoch = 0, chain = CHAIN, snapshotTerms = terms, anchorHash = startHash,
  candidateHash = anchorHash, candidateBlock = anchorBlock, unopened = false } = {}) {
  const blocks = n => ({ block_number: n, block_hash: hex(0xb000n + BigInt(n)) });
  return {
    getChainId: async () => hex(chain),
    getBlockNumber: async () => head,
    getBlockWithTxHashes: async n => blocks(n),
    getClassHashAt: async () => hex(CLASS),
    getNonceForAddress: async () => '0x3',
    callContract: async call => {
      if (call.entrypoint === 'os_program') return [hex(OS)];
      assert.equal(call.entrypoint, 'snapshot');
      // How an RPC reports the channel's revert for a game nobody opened.
      if (unopened) throw Object.assign(Error('RPC: starknet_call with params ... Contract error'),
        { baseError: { code: 40, message: 'Contract error', data: { revert_error: 'Execution failed: 0x556e6b6e6f776e206368616e6e656c (\'Unknown channel\')' } } });
      return [...encodeTerms(counter, snapshotTerms), BigInt(epoch), anchorHash, BigInt(anchorBlock),
        candidateHash, BigInt(candidateBlock)].map(hex);
    },
  };
}

test('snapshots must identify this game on this chain', async () => {
  const snap = await getSnapshot(fakeProvider(), counter, terms.channel, terms.game_id);
  assert.equal(snap.anchor_hash, startHash);
  assert.equal(snap.anchor_block, 100);
  await assert.rejects(getSnapshot(fakeProvider(), counter, terms.channel, 8n), /another game/);
  await assert.rejects(getSnapshot(fakeProvider({ chain: CHAIN + 1n }), counter, terms.channel, terms.game_id), /another chain/);
});

// A local starknet_proveTransaction endpoint that answers like the hosted prover.
async function withProver(answer, run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const q = JSON.parse(body); requests.push(q);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...answer(q) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('proveSession proves from the anchor and returns the settle call', async () => {
  const base = { block_number: 130, block_hash: hex(0xb000n + 130n) };
  await withProver(() => ({ result: response({ block: base }) }), async (proverUrl, requests) => {
    const proved = await proveSession({ provider: fakeProvider(), proverUrl, session, epoch: 0, expectedClassHash: CLASS });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'starknet_proveTransaction');
    assert.deepEqual(requests[0].params.block_id, { block_hash: base.block_hash });
    assert.deepEqual(requests[0].params.transaction, provingTransaction({ session, epoch: 0, nonce: 3 }));
    assert.equal(proved.block.block_number, 130);
    assert.equal(proved.endHash, endHash);
    assert.equal(proved.options.proof, response().proof);
    assert.deepEqual(proved.call(), settlementCall(counter, { prover: terms.prover, channel: terms.channel,
      gameId: terms.game_id, epoch: 0, startHash, end: session.env }));
  });
});

test('proveSession extends the candidate once the candidate is deep enough', async () => {
  const base = { block_number: 130, block_hash: hex(0xb000n + 130n) };
  await withProver(() => ({ result: response({ block: base }) }), async (proverUrl, requests) => {
    // The anchor is some older state; the session starts at the candidate, set in block 120.
    const provider = fakeProvider({ anchorHash: 0xa11n, anchorBlock: 50, candidateHash: startHash, candidateBlock: 120 });
    const proved = await proveSession({ provider, proverUrl, session, epoch: 0, expectedClassHash: CLASS });
    assert.equal(proved.call().calldata.map(BigInt)[3], startHash);
    const prove = extra => proveSession({ provider, proverUrl, session, epoch: 0, expectedClassHash: CLASS, waitMs: 0, ...extra });
    await assert.rejects(prove({ blockNumber: 119 }), /Proof base must follow/);
    await assert.rejects(proveSession({ provider: fakeProvider({ candidateHash: startHash, candidateBlock: 135, anchorHash: 0xa11n }),
      proverUrl, session, epoch: 0, expectedClassHash: CLASS, waitMs: 0 }), /not yet 10 blocks deep/);
    assert.equal(requests.length, 1);
  });
});

test('proveSession refuses stale or foreign sessions before calling the prover', async () => {
  await withProver(() => ({ error: { code: 1, message: 'must not be called' } }), async (proverUrl, requests) => {
    const prove = (provider, extra = {}) => proveSession({ provider, proverUrl, session, epoch: 0, expectedClassHash: CLASS, waitMs: 0, ...extra });
    await assert.rejects(prove(fakeProvider({ head: 105 })), /not yet 10 blocks deep/);
    await assert.rejects(prove(fakeProvider({ epoch: 1 })), /Stale proving epoch/);
    await assert.rejects(prove(fakeProvider({ anchorHash: endHash })), /does not start at the chain anchor or candidate/);
    await assert.rejects(prove(fakeProvider(), { expectedClassHash: CLASS + 1n }), /Unexpected prover class/);
    await assert.rejects(prove(fakeProvider(), { blockNumber: 99 }), /Proof base must follow the anchor/);
    await assert.rejects(prove(fakeProvider(), { expectedClassHash: undefined }), /allowlisted prover class/);
    assert.equal(requests.length, 0);
  });
});

test('a game nobody opened yet is proved from its terms', async () => {
  const base = { block_number: 130, block_hash: hex(0xb000n + 130n) };
  assert.equal(await snapshotIfOpen(fakeProvider({ unopened: true }), counter, terms.channel, terms.game_id), null);
  assert(reverted(Error('x'), 'x') && !reverted(Error('timeout'), 'Unknown channel'));
  await withProver(() => ({ result: response({ block: base }) }), async (proverUrl, requests) => {
    const provider = fakeProvider({ unopened: true });
    const proved = await proveSession({ provider, proverUrl, session, epoch: 0, expectedClassHash: CLASS });
    assert.equal(proved.opening, true);
    assert.deepEqual(requests[0].params.transaction, provingTransaction({ session, epoch: 0, nonce: 3, opening: true }));
    // Any block 10 deep: the terms fix the opening state.
    assert.equal(proved.block.block_number, 130);
    assert.deepEqual(proved.call(), settlementCall(counter, { prover: terms.prover, channel: terms.channel,
      gameId: terms.game_id, epoch: 0, startHash, end: session.env }));
    const prove = extra => proveSession({ provider, proverUrl, session, expectedClassHash: CLASS, waitMs: 0, epoch: 0, ...extra });
    await assert.rejects(prove({ epoch: 1 }), /Stale proving epoch/);
    const later = new Session(counter, terms, { start: session.env, witness: session.witness() });
    await assert.rejects(prove({ session: later }), /does not start at the opening/);
    assert.equal(requests.length, 1);
    // An open game proves as before, with no terms in the calldata.
    const open = await proveSession({ provider: fakeProvider(), proverUrl, session, epoch: 0, expectedClassHash: CLASS });
    assert.equal(open.opening, false);
    assert.deepEqual(requests[1].params.transaction.calldata.slice(-1), ['0x1']);
  });
});

test('prover errors surface with their RPC error attached', async () => {
  await withProver(() => ({ error: { code: 55, message: 'Not enough twiddles!' } }), async proverUrl => {
    await assert.rejects(proveSession({ provider: fakeProvider(), proverUrl, session, epoch: 0, expectedClassHash: CLASS }),
      e => e.rpcError?.message === 'Not enough twiddles!');
  });
});
