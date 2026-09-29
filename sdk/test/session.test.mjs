// SDK tests over the counter game. The Cairo fixtures in
// examples/counter/src/fixtures.cairo were produced by the same SDK, and the
// Cairo tests replay them, so these tests pin the JS side of that contract.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REASON_RESIGN, Reader, Session, ZERO_SIGNATURE, contextHash, decodeChannelGame, decodeSnapshot,
  decodeTerms, encodeBatch, encodeSignatures, encodeTerms, finalSignatures, play, playRandom,
  proofMessageHash, proofPayload, publicKey, rebase, replay, resign, reveal, rngChain, stateHash, tag,
} from '../src/index.mjs';
import { ADD, GAMBLE, counter } from '../examples/counter.mjs';

const keys = [0x1a2b3cn, 0x4d5e6fn];
const chains = [rngChain(0x5eed0n, 8), rngChain(0x5eed1n, 8)];
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 1n, prover: 0xad0b7e5n, response_seconds: 3600,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: chains.map(c => c[8]), config: { target: 20 },
};
const add = amount => play({ kind: ADD, amount });

function played() {
  const session = new Session(counter, terms);
  session.move(add(3), keys[0]);
  session.move(playRandom({ kind: GAMBLE, amount: 0 }, chains[1][7]), keys[1]);
  session.move(reveal(chains[0][7]), keys[0]);
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
  assert.throws(() => session.move(add(4), keys[0]), /Invalid amount/);
  assert.throws(() => session.move(add(1), keys[1]), /Wrong signing key/);
  assert.throws(() => session.move(play({ kind: GAMBLE, amount: 0 }), keys[0]), /Randomness requested/);
  assert.throws(() => session.move(playRandom({ kind: ADD, amount: 1 }, chains[0][6]), keys[0]), /Unexpected entropy/);
  assert.throws(() => session.move(reveal(chains[0][6]), keys[0]), /No reveal due/);
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

test('a stale copy with the last-signed marks cannot equivocate', () => {
  const session = new Session(counter, terms);
  session.move(add(3), keys[0]);
  const atOne = structuredClone(session.export());
  session.move(add(2), keys[1]);
  session.move(add(1), keys[0]);
  const marks = session.lastSigned;
  assert.deepEqual(marks.map(m => m.seq), [2, 1]);

  const stale = Session.import(counter, structuredClone(atOne), { lastSigned: marks });
  assert.throws(() => stale.move(add(3), keys[1]), /Would equivocate: this key signed a different step at seq 1/);
  // Re-signing the same step is harmless and gives the same signature.
  assert.deepEqual(stale.move(add(2), keys[1]).signature, session.steps[1].signature);
  assert.throws(() => stale.move(add(2), keys[0]), /Would equivocate/);
  stale.move(add(1), keys[0]);
  assert.equal(stale.stateHash(), session.stateHash());

  const opening = Session.import(counter, { ...structuredClone(atOne), steps: [] }, { lastSigned: marks });
  assert.throws(() => opening.move(add(3), keys[0]), /Session is behind seq 2, which this key signed/);
});

test('a branch that drops a signed step is refused, and a later anchor supersedes it', () => {
  const signed = new Session(counter, terms);
  signed.move(add(3), keys[0]);
  const prefix = structuredClone(signed.export());
  signed.move(add(2), keys[1]);
  // Without marks two copies still fork freely; the fork carries the other branch.
  const fork = Session.import(counter, structuredClone(prefix));
  fork.move(add(1), keys[1]);
  fork.move(add(1), keys[0]);
  const forked = Session.import(counter, structuredClone(fork.export()), { lastSigned: signed.lastSigned });
  assert.throws(() => forked.move(add(1), keys[1]), /Would equivocate: this key signed a different step at seq 1/);
  assert.equal(forked.includes({ seq: 1, transcript: signed.steps[1].transcript }), true);
  assert.equal(forked.includes({ seq: 2, transcript: signed.env.transcript }), false);

  const anchored = new Session(counter, terms, { start: fork.env, lastSigned: signed.lastSigned });
  anchored.move(add(1), keys[1]);
  assert.equal(anchored.includes({ seq: 1, transcript: 0n }), true);
});

test('a signed step is checked against the rules before the mark moves', () => {
  const session = played();
  const mark = session.lastSigned[0];
  assert.throws(() => session.sign(add(4), keys[0]), /Invalid amount/);
  assert.equal(session.lastSigned[0], mark);
  const record = session.sign(add(1), keys[0]);
  assert.equal(session.env.seq, 3);
  assert.deepEqual([record.seq, record.transcript, session.lastSigned[0]], [3, session.env.transcript, record]);
  assert.equal(session.receive(record), record);
  assert.equal(session.env.seq, 4);
});

test('rebase restarts a session at a committed anchor', () => {
  const session = played();
  const pending = new Session(counter, terms);
  session.steps.slice(0, 2).forEach(record => pending.receive(record));
  assert.equal(pending.env.pending.active, true);
  const base = rebase(session, pending.stateHash());
  assert.deepEqual([base.start.seq, base.steps.length, base.stateHash()], [2, 1, session.stateHash()]);
  assert.deepEqual(base.steps[0], session.steps[2]);
  assert.equal(rebase(session, stateHash(counter, session.start)).steps.length, 3);
  assert.equal(rebase(session, session.stateHash()).steps.length, 0);
  assert.equal(rebase(session, 0x123n), null);
});

test('replay calldata carries one final signature per seat', () => {
  const session = played();
  assert.deepEqual(session.steps.map(s => s.seat), [0, 1, 0]);
  const batch = session.batch();
  assert.deepEqual(batch.signatures, [session.steps[2].signature, session.steps[1].signature]);
  assert.deepEqual([batch.stamps, batch.attestation], [[], ZERO_SIGNATURE]);
  assert.deepEqual(finalSignatures(session.steps.slice(0, 1)), [session.steps[0].signature, ZERO_SIGNATURE]);
  const calldata = encodeBatch(counter, batch);
  // 3 steps: Play(ADD 3) = 3 felts, PlayRandom(GAMBLE, entropy) = 4, Reveal(value) = 2; then no
  // stamps, 2 signatures and a zero attestation.
  assert.deepEqual(calldata.slice(0, 4), [3n, 0n, BigInt(ADD), 3n]);
  assert.equal(calldata.length, 1 + 3 + 4 + 2 + 1 + 1 + 4 + 2);
});

test('resignation ends the game for the other seat', () => {
  const session = played();
  session.move(resign(1), keys[1]);
  assert.deepEqual(session.env.outcome, { finished: true, winner: 1, reason: REASON_RESIGN });
});

test('terms, snapshots and channels decode from Cairo serialization', () => {
  const encoded = encodeTerms(counter, terms);
  assert.deepEqual(decodeTerms(counter, encoded), { ...terms, clock: null, response_seconds: 3600, config: { target: 20 } });
  const snapshot = decodeSnapshot(counter, [...encoded, 2n, 0xabcn, 77n, 0xdefn, 88n]);
  assert.equal(snapshot.epoch, 2);
  assert.equal(snapshot.anchor_hash, 0xabcn);
  assert.equal(snapshot.anchor_block, 77);
  assert.deepEqual([snapshot.candidate_hash, snapshot.candidate_block], [0xdefn, 88]);
  const ref = [0x11n, 5n, 3n, 1n, 1n, 2n, 1n];
  const channel = decodeChannelGame(counter, [
    9n, 0xa11cen, 0xb0bn, 1n, 2n, 3n, 4n, 0xad0b7e5n, 1n, 20n, 4n, 2n, 0xc0n, 3600n, 0x7en, 4n, 30000n, 60000n, 2000n, 1n,
    ...ref, ...ref, 55n, 56n, 0n, 3n, 900n, 1n, 2n, 1n,
  ]);
  assert.deepEqual([channel.anchor_block, channel.candidate_block, channel.deadline], [55, 56, 0]);
  assert.deepEqual([channel.acked_epoch, channel.acked_deadline], [3, 900]);
  assert.equal(channel.config.target, 20);
  assert.deepEqual(channel.clock, { referee: 0x7en, settings: { turn_ms: 30000, bank_ms: 60000, increment_ms: 2000, byoyomi: null } });
  assert.equal(channel.status, 4);
  assert.deepEqual(channel.anchor.outcome, { finished: true, winner: 2, reason: 1 });
  assert.deepEqual(channel.result, { finished: true, winner: 2, reason: 1 });
  assert.throws(() => decodeTerms(counter, [...encoded, 1n]), /Trailing encoding/);
  assert.throws(() => new Reader([]).next(), /Truncated encoding/);
});

test('approvals encode as a span of signatures', () => {
  assert.deepEqual(encodeSignatures([ZERO_SIGNATURE, ZERO_SIGNATURE]), [2n, 0n, 0n, 0n, 0n]);
});

test('proof payload binds the game, epoch and both state hashes', () => {
  const context = contextHash(counter, terms);
  const payload = proofPayload(counter, { classHash: 7n, prover: 8n, terms, context, epoch: 3, startHash: 1n, endHash: 2n });
  assert.deepEqual(payload.slice(1, 3), [tag('COUNTER'), tag('REFEREE_PROVED_V1')]);
  assert.equal(payload.length, 11);
  assert.notEqual(proofMessageHash(8n, payload), proofMessageHash(9n, payload));
});
