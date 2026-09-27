// Timed games: a referee stamps every step and flags a seat whose time runs
// out. The Cairo side replays the same rules against the timed fixture game
// (examples/counter/src/clock_tests.cairo).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REASON_RESIGN, REASON_TIMEOUT, REFEREE, Referee, Session, ZERO_SIGNATURE, decodeTerms, encodeBatch, encodeTerms,
  flag, play, playRandom, publicKey, recommit, resign, reveal, rngChain, signedStep, tag, timeLeft,
} from '../src/index.mjs';
import { SessionStore, memoryBackend } from '../src/store.mjs';
import { ADD, GAMBLE, counter } from '../examples/counter.mjs';

const keys = [0x1a2b3cn, 0x4d5e6fn], refereeKey = 0x7e7e7en;
const chains = [rngChain(0x5eed0n, 8), rngChain(0x5eed1n, 8)];
const clock = { referee: publicKey(refereeKey), turn_ms: 30000, bank_ms: 60000, increment_ms: 2000 };
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 2n, prover: 0xad0b7e5n, response_seconds: 3600, clock,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: chains.map(c => c[8]), config: { target: 20 },
};
const add = amount => play({ kind: ADD, amount });
const T0 = 1_000_000;

/** A referee from a fresh session at wall time T0, and a seat's view of the same game. */
function table() {
  return { referee: new Referee(new Session(counter, terms), refereeKey, { now: T0 }), seat: new Session(counter, terms) };
}

/** The seat signs `step`, the referee stamps it at `now`, and the seat applies the stamped record. */
function play1(referee, seat, step, now) {
  const record = referee.stamp(seat.sign(step, keys[seat.due()]), now);
  seat.receive(record);
  return record;
}

test('the referee stamps each step and every seat verifies the stamps', () => {
  const { referee, seat } = table();
  const first = play1(referee, seat, add(3), T0);
  assert.equal(first.stamp, T0);
  play1(referee, seat, add(3), T0 + 45000);
  // Seat 1 spent its 30 s allowance and 15 s of bank, then gained 2 s.
  assert.deepEqual(seat.env.clock, { banks: [62000, 47000], turn: 30000, stamp: T0 + 45000 });
  assert.equal(seat.stateHash(), referee.session.stateHash());
  const copy = Session.import(counter, structuredClone(seat.export()));
  assert.equal(copy.stateHash(), seat.stateHash());
  assert.equal(copy.export().version, 3);
});

test('a seat whose time runs out is flagged', () => {
  const { referee, seat } = table();
  play1(referee, seat, add(3), T0);
  // Seat 1 has its 30 s allowance and 60 s bank.
  assert.equal(referee.deadline(), T0 + 90001);
  assert.equal(referee.flag(T0 + 90000), null);
  const late = seat.sign(add(3), keys[1]);
  assert.throws(() => referee.stamp(late, T0 + 90001), /Flag fell/);
  const record = referee.flag(T0 + 90001);
  assert.equal(record.seat, REFEREE);
  seat.receive(record);
  assert.deepEqual(seat.env.outcome, { finished: true, winner: 1, reason: REASON_TIMEOUT });
  assert.equal(referee.deadline(), null);
});

test('a withheld reveal runs the revealer\'s clock', () => {
  const { referee, seat } = table();
  play1(referee, seat, add(3), T0);
  play1(referee, seat, playRandom({ kind: GAMBLE, amount: 0 }, chains[1][7]), T0 + 1000);
  // Seat 0 owes the reveal: a fresh 30 s allowance plus its 62 s bank.
  assert.equal(referee.deadline(), T0 + 1000 + 30000 + 62000 + 1);
  seat.receive(referee.flag(T0 + 93001));
  assert.equal(seat.env.outcome.winner, 2);
  assert.equal(seat.env.pending.active, false);
});

test('reveals are timed on their own and leave the turn allowance alone', () => {
  const { referee, seat } = table();
  play1(referee, seat, add(3), T0);
  play1(referee, seat, playRandom({ kind: GAMBLE, amount: 0 }, chains[1][7]), T0 + 40000);
  play1(referee, seat, reveal(chains[0][7]), T0 + 45000);
  // Seat 1 paid 10 s of bank for its gamble; the roll passed the turn and added its increment.
  assert.deepEqual(seat.env.clock, { banks: [62000, 52000], turn: 30000, stamp: T0 + 45000 });
});

test('a restarted referee does not charge for its downtime', () => {
  const { referee, seat } = table();
  play1(referee, seat, add(3), T0);
  const restored = Session.import(counter, structuredClone(referee.session.export()));
  // Back an hour later: seat 1 still has all of its time.
  const later = new Referee(restored, refereeKey, { now: T0 + 3_600_000 });
  assert.equal(later.flag(T0 + 3_600_000 + 90000), null);
  assert.equal(later.deadline(), T0 + 3_600_000 + 90001);
  const record = later.stamp(seat.sign(add(3), keys[1]), T0 + 3_600_000 + 5000);
  assert.equal(record.stamp, T0 + 5000);
});

test('stamps need the referee\'s attestation', () => {
  const { referee, seat } = table();
  const record = referee.stamp(seat.sign(add(3), keys[0]), T0);
  const forged = { ...record, stamp: T0 + 1 };
  assert.throws(() => new Session(counter, terms).receive(forged), /Invalid referee attestation/);
  const { stamp, attestation, ...unstamped } = record;
  assert.throws(() => new Session(counter, terms).receive(unstamped), /stamp on every step/);
  assert.throws(() => new Referee(new Session(counter, terms), keys[0]), /Wrong referee key/);
  // Seats cannot flag: a flag needs the referee's key.
  assert.throws(() => referee.session.stamp({ step: flag() }, T0 + 100000, keys[1]), /Wrong referee key/);
});

test('seats apply their own steps only once stamped', async () => {
  const { referee, seat } = table();
  assert.throws(() => seat.move(add(3), keys[0]), /once the referee stamps it/);
  const store = new SessionStore(memoryBackend());
  const stored = await store.open(counter, terms);
  const signed = await store.move(stored, add(3), keys[0]);
  assert.equal(stored.env.seq, 0);
  // Signing again starts from the tip, where the turn has passed...
  await assert.rejects(store.move(stored, add(2), keys[0]), /Wrong signing key/);
  // ...and a copy without the pending step still refuses another step at its seq.
  assert.throws(() => new Session(counter, terms, { lastSigned: stored.lastSigned }).sign(add(2), keys[0]), /Would equivocate/);
  await store.receive(stored, referee.stamp(signed, T0));
  assert.equal(stored.env.seq, 1);
  assert.equal((await store.load(counter, terms)).env.seq, 1);
});

test('a timed batch carries every stamp and the last attestation', () => {
  const { referee, seat } = table();
  play1(referee, seat, add(3), T0);
  play1(referee, seat, add(3), T0 + 1000);
  seat.receive(referee.flag(T0 + 1000 + 92001));
  const batch = seat.batch();
  assert.deepEqual(batch.stamps, [T0, T0 + 1000, T0 + 93001]);
  assert.deepEqual(batch.attestation, seat.steps[2].attestation);
  // The referee's flag has no seat signature.
  assert.deepEqual(batch.signatures, [seat.steps[0].signature, seat.steps[1].signature]);
  const calldata = encodeBatch(counter, batch);
  // Steps: 3 + 3 + 1 felts; stamps: 1 + 3; signatures: 1 + 4; attestation: 2.
  assert.equal(calldata.length, 1 + 7 + 4 + 5 + 2);
  assert.deepEqual(calldata.slice(8, 12), [3n, BigInt(T0), BigInt(T0 + 1000), BigInt(T0 + 93001)]);
});

test('untimed games take no stamps', () => {
  const untimed = { ...terms, clock: null };
  const session = new Session(counter, untimed);
  const record = session.sign(add(3), keys[0]);
  assert.throws(() => session.receive({ ...record, stamp: T0 }), /Stamp in an untimed game/);
  assert.throws(() => new Referee(session, refereeKey), /Untimed game/);
  assert.equal(session.batch().attestation, ZERO_SIGNATURE);
});

test('time controls round-trip through Cairo serialization', () => {
  const decoded = decodeTerms(counter, encodeTerms(counter, terms));
  assert.deepEqual(decoded.clock, clock);
  assert.throws(() => new Session(counter, { ...terms, clock: { ...clock, turn_ms: 0, bank_ms: 0 } }), /Invalid time control/);
});

test('time left counts down the due seat only', () => {
  const { referee, seat } = table();
  play1(referee, seat, add(3), T0);
  assert.deepEqual(timeLeft(counter, terms, seat.env, T0 + 40000), [62000, 50000]);
  assert.deepEqual(timeLeft(counter, terms, seat.env, T0 + 200000), [62000, 0]);
  assert.equal(timeLeft(counter, { ...terms, clock: null }, new Session(counter, { ...terms, clock: null }).env, T0), null);
});

// Seat 0 may recommit its hash chain and then play in one turn: two steps.
const newTip = rngChain(0x5eed2n, 8)[8];

test('a seat signs ahead through its turn and the stamps catch up', () => {
  const { referee, seat } = table();
  const first = seat.sign(recommit(newTip), keys[0]);
  const second = seat.sign(add(3), keys[0]);
  assert.deepEqual(seat.pending.map(r => r.seq), [0, 1]);
  assert.deepEqual([seat.env.seq, seat.tip.seq], [0, 2]);
  // At the tip the turn has passed to seat 1.
  assert.throws(() => seat.sign(add(1), keys[0]), /Wrong signing key/);
  seat.receive(referee.stamp(first, T0));
  assert.deepEqual(seat.pending.map(r => r.seq), [1]);
  seat.receive(referee.stamp(second, T0 + 300));
  assert.deepEqual(seat.pending, []);
  assert.equal(seat.stateHash(), referee.session.stateHash());
});

test('another step landing first drops the steps signed ahead', () => {
  const { referee, seat } = table();
  seat.sign(recommit(newTip), keys[0]);
  seat.sign(add(3), keys[0]);
  // Seat 1 resigns before seat 0's steps reach the referee.
  const bob = new Session(counter, terms);
  seat.receive(referee.stamp(bob.sign(resign(1), keys[1]), T0));
  assert.deepEqual(seat.pending, []);
  assert.equal(seat.env.outcome.reason, REASON_RESIGN);
});

test('a store keeps steps signed ahead across a restart', async () => {
  const backend = memoryBackend();
  const store = new SessionStore(backend);
  const session = await store.open(counter, terms);
  await store.move(session, recommit(newTip), keys[0]);
  await store.move(session, add(3), keys[0]);
  // A new tab or a restart restores both, ready to resend.
  const restored = await new SessionStore(backend).load(counter, terms);
  assert.deepEqual(restored.pending.map(r => r.seq), [0, 1]);
  const { referee } = table();
  const stamped = restored.pending.map((r, i) => referee.stamp(signedStep(r), T0 + i));
  await store.receive(restored, signedStep(stamped[0]));
  assert.deepEqual(restored.pending.map(r => r.seq), [1]);
  await store.receive(restored, signedStep(stamped[1]));
  assert.deepEqual([restored.pending, restored.env.seq], [[], 2]);
});

test('a failed write never releases the step it signed', async () => {
  const backend = memoryBackend();
  const store = new SessionStore(backend);
  const session = await store.open(counter, terms);
  const update = backend.update;
  backend.update = async (key, fn) => { if (key.startsWith('signed/')) { fn(undefined); throw Error('disk full'); } return update(key, fn); };
  await assert.rejects(store.move(session, add(3), keys[0]), /disk full/);
  assert.deepEqual(session.pending, []);
});
