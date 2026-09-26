// SDK tests over the counter game. The Cairo fixtures in
// examples/counter/src/fixtures.cairo were produced by the same SDK, and the
// Cairo tests replay them, so these tests pin the JS side of that contract.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MOVE_PLAY, MOVE_RESIGN, MOVE_REVEAL, REASON_RESIGN, Reader, Session, ZERO_SIGNATURE, contextHash,
  decodeChannelGame, decodeSnapshot, decodeTerms, encodeSignatures, encodeSignedSteps, encodeTerms,
  proofMessageHash, proofPayload, publicKey, replay, rngChain, tag,
} from '../src/index.mjs';
import { ADD, GAMBLE, counter } from '../examples/counter.mjs';

const keys = [0x1a2b3cn, 0x4d5e6fn];
const chains = [rngChain(0x5eed0n, 8), rngChain(0x5eed1n, 8)];
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 1n, prover: 0xad0b7e5n, response_seconds: 3600,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: chains.map(c => c[8]), config: { target: 20 },
};
const add = (seat, amount) => ({ seat, move: { kind: MOVE_PLAY, action: { kind: ADD, amount } } });

function played() {
  const session = new Session(counter, terms);
  session.move(add(0, 3), keys[0]);
  session.move({ seat: 1, move: { kind: MOVE_PLAY, action: { kind: GAMBLE, amount: 0 } }, entropy: chains[1][7] }, keys[1]);
  session.move({ seat: 0, move: { kind: MOVE_REVEAL, value: chains[0][7] } }, keys[0]);
  return session;
}

test('a session applies signed steps and reveals', () => {
  const session = played();
  assert.equal(session.env.seq, 3);
  assert.equal(session.env.support_turn, 3);
  assert.equal(session.env.pending.active, false);
  assert.equal(session.due(), 0);
  assert.ok(session.env.game.total >= 4 && session.env.game.total <= 9);
});

test('the other client verifies every signature', () => {
  const alice = played();
  const bob = new Session(counter, terms);
  for (const signed of alice.steps) bob.receive(signed);
  assert.equal(bob.stateHash(), alice.stateHash());
  const forged = { ...alice.steps[0], signature: { ...alice.steps[0].signature, s: alice.steps[0].signature.s ^ 1n } };
  assert.throws(() => new Session(counter, terms).receive(forged), /Invalid session signature/);
});

test('a rejected step leaves the session unchanged', () => {
  const session = played();
  const before = session.stateHash();
  assert.equal(session.due(), 0);
  assert.throws(() => session.move(add(0, 4), keys[0]), /Invalid amount/);
  assert.throws(() => session.move(add(0, 1), keys[1]), /Wrong signing key/);
  assert.throws(() => session.move(add(1, 1), keys[1]), /Not your turn/);
  assert.equal(session.stateHash(), before);
  assert.equal(session.steps.length, 3);
});

test('export and import round-trip through full verification', () => {
  const session = played();
  const copy = Session.import(counter, structuredClone(session.export()));
  assert.equal(copy.stateHash(), session.stateHash());
  const { env } = replay(counter, terms, session.start, null, session.steps);
  assert.equal(env.transcript, session.env.transcript);
});

test('resignation ends the game for the other seat', () => {
  const session = played();
  session.move({ seat: 1, move: { kind: MOVE_RESIGN } }, keys[1]);
  assert.deepEqual(session.env.outcome, { finished: true, winner: 1, reason: REASON_RESIGN });
});

test('terms, snapshots and channels decode from Cairo serialization', () => {
  const encoded = encodeTerms(counter, terms);
  assert.deepEqual(decodeTerms(counter, encoded), { ...terms, response_seconds: 3600, config: { target: 20 } });
  const snapshot = decodeSnapshot(counter, [...encoded, 2n, 0xabcn, 77n]);
  assert.equal(snapshot.epoch, 2);
  assert.equal(snapshot.anchor_hash, 0xabcn);
  assert.equal(snapshot.anchor_block, 77);
  const ref = [0x11n, 5n, 3n, 1n, 1n, 2n, 1n];
  const channel = decodeChannelGame(counter, [
    9n, 0xa11cen, 0xb0bn, 1n, 2n, 3n, 4n, 0xad0b7e5n, 1n, 20n, 4n, 2n, 0xc0n, 3600n, ...ref, ...ref, 55n, 0n, 1n, 2n, 1n,
  ]);
  assert.equal(channel.config.target, 20);
  assert.equal(channel.status, 4);
  assert.deepEqual(channel.anchor.outcome, { finished: true, winner: 2, reason: 1 });
  assert.deepEqual(channel.result, { finished: true, winner: 2, reason: 1 });
  assert.throws(() => decodeTerms(counter, [...encoded, 1n]), /Trailing encoding/);
  assert.throws(() => new Reader([]).next(), /Truncated encoding/);
});

test('calldata encodes spans of signed steps and approvals', () => {
  const session = played();
  const steps = encodeSignedSteps(counter, session.steps);
  assert.equal(steps[0], 3n);
  assert.deepEqual(encodeSignatures([ZERO_SIGNATURE, ZERO_SIGNATURE]), [2n, 0n, 0n, 0n, 0n]);
});

test('proof payload binds the game, epoch and both state hashes', () => {
  const context = contextHash(counter, terms);
  const payload = proofPayload(counter, { classHash: 7n, prover: 8n, terms, context, epoch: 3, startHash: 1n, endHash: 2n });
  assert.deepEqual(payload.slice(1, 3), [tag('COUNTER'), tag('REFEREE_PROVED_V1')]);
  assert.equal(payload.length, 11);
  assert.notEqual(proofMessageHash(8n, payload), proofMessageHash(9n, payload));
});
