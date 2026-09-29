// Protocol v4 in the SDK: the referee's start step, recommits only after a
// reveal, the transcript cap, and answering disputes from the candidate. The
// Cairo side replays the same rules (examples/counter/src/tests.cairo,
// clock_tests.cairo) and the fixtures pin the hashes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REFEREE, Referee, Session, applySteps, contextHash, disputeAnswer, liveHash, open, outranks, play, playRandom,
  prefix, publicKey, recommit, refereeResumeHash, reveal, rngChain, start, stateHash, tag, verify,
} from '../src/index.mjs';
import { ADD, GAMBLE, LIMIT, counter } from '../examples/counter.mjs';

const keys = [0x1a2b3cn, 0x4d5e6fn], refereeKey = 0x7e7e7en;
const chains = [rngChain(0x5eed0n, 8), rngChain(0x5eed1n, 8)];
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 9n, prover: 0xad0b7e5n, response_seconds: 3600, clock: null,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: chains.map(c => c[8]), config: { target: 20 },
};
const timed = { ...terms, clock: { referee: publicKey(refereeKey), settings: { turn_ms: 30000, bank_ms: 60000, increment_ms: 2000, byoyomi: null } } };
const add = amount => play({ kind: ADD, amount });
const gamble = entropy => playRandom({ kind: GAMBLE, amount: 0 }, entropy);
const run = (steps, stamps = [], t = terms) => applySteps(counter, contextHash(counter, t), t, open(counter, t), null, steps, stamps);
const newTip = rngChain(0x5eed2n, 8)[8];

test('a seat recommits only after it revealed, once per reveal', () => {
  assert.deepEqual(open(counter, terms).rng_fresh, [true, true]);
  assert.throws(() => run([recommit(newTip)]), /Nothing revealed to recommit/);
  // Seat 0 gambles and seat 1 reveals: seat 1 is due and has revealed.
  const revealed = [gamble(chains[0][7]), reveal(chains[1][7])];
  const env = run([...revealed, recommit(newTip)]);
  assert.deepEqual(env.rng_fresh, [false, true]);
  assert.throws(() => run([...revealed, recommit(newTip), recommit(newTip)]), /Nothing revealed to recommit/);
});

test('an untimed game takes no referee steps', () => {
  assert.throws(() => run([start()]), /Untimed game/);
});

test('start runs the clock from before the first move and restarts it without charging', () => {
  let env = run([start(), add(3)], [1000, 41000], timed);
  assert.deepEqual(env.clock.seats.banks, [52000, 60000]);
  env = run([add(3), start(), add(3)], [1000, 50000, 51000], timed);
  assert.deepEqual(env.clock.seats.banks, [62000, 62000]);
  assert.throws(() => run([add(3), start()], [5000, 4000], timed), /Stamp out of order/);
});

test('the referee signs start steps, liveness and resumes', () => {
  const referee = new Referee(new Session(counter, timed), refereeKey, { now: 1_000_000 });
  const record = referee.start(1_000_000);
  assert.equal(record.seat, REFEREE);
  assert.equal(referee.session.env.clock.stamp, 1_000_000);
  const seat = new Session(counter, timed);
  seat.receive(record);
  assert.equal(seat.stateHash(), referee.session.stateHash());
  const context = contextHash(counter, timed), key = publicKey(refereeKey);
  assert.ok(verify(liveHash(counter, context, 1, 3600), referee.acknowledgement(1, 3600), key));
  assert.ok(verify(refereeResumeHash(counter, context, 2, 0xabcn), referee.resumeSignature(2, 0xabcn), key));
});

test('the transcript cap ends a game at max_steps, after any pending reveal', () => {
  // Target 20 allows 96 steps; even steps that change nothing count.
  const starts = n => Array(n).fill(start());
  const stamps = n => Array.from({ length: n }, (_, i) => 1000 + i);
  let env = run(starts(96), stamps(96), timed);
  assert.deepEqual([env.seq, env.outcome], [96, { finished: true, winner: 0, reason: LIMIT }]);
  assert.throws(() => run(starts(97), stamps(97), timed), /Game already finished/);
  // Seat 1's gamble is step 96; the cap waits for seat 0's reveal.
  env = run([add(3), ...starts(94), gamble(chains[1][7])], [1000, ...stamps(94).map(t => t + 1), 2000], timed);
  assert.ok(env.pending.active && !env.outcome.finished);
  env = applySteps(counter, contextHash(counter, timed), timed, env, null, [reveal(chains[0][7])], [3000]);
  assert.deepEqual([env.seq, env.outcome.reason], [97, LIMIT]);
});

/** A signed untimed game: seats alternate adding 3 until someone wins. */
function played(n) {
  const session = new Session(counter, terms);
  for (let i = 0; i < n; i++) session.move(add(3), keys[session.due()]);
  return session;
}
const refOf = env => ({ hash: stateHash(counter, env), seq: env.seq, support_turn: env.support_turn });

test('a dispute answer extends the candidate when the history holds it', () => {
  const session = played(7);
  const opening = session.start;
  const channel = { anchor: refOf(opening), candidate: refOf(opening) };
  // From the anchor, cut to three steps.
  const first = disputeAnswer(session, channel, { maxSteps: 3 });
  assert.equal(first.start.seq, 0);
  assert.equal(first.env.seq, 3);
  // Once that is the candidate, the next answer starts there.
  const next = disputeAnswer(session, { ...channel, candidate: refOf(first.env) }, { maxSteps: 3 });
  assert.equal(next.start.seq, 3);
  assert.equal(next.env.seq, 6);
  assert.ok(outranks(next.env, refOf(first.env)));
  // Nothing past the candidate: no answer.
  assert.equal(disputeAnswer(session, { ...channel, candidate: refOf(session.env) }), null);
  // A candidate the history doesn't hold: answer from the anchor, if it outranks.
  assert.equal(disputeAnswer(session, { ...channel, candidate: { hash: 0xbadn, seq: 9, support_turn: 9 } }), null);
  assert.equal(prefix(session, 99), session);
  assert.equal(prefix(session, 2).steps.length, 2);
});

test('a seat whose step lost its position to the referee signs on', () => {
  const referee = new Referee(new Session(counter, timed), refereeKey, { now: 1_000_000 });
  const seat = new Session(counter, timed);
  // Seat 0 signs its first move, but the referee's start takes seq 0 first.
  seat.sign(add(3), keys[0]);
  seat.receive(referee.start(1_000_000));
  assert.deepEqual(seat.pending, []);
  // Seat 0 signs again at seq 1, and the referee stamps it.
  const record = referee.stamp(seat.sign(add(3), keys[0]), 1_001_000);
  seat.receive(record);
  assert.equal(seat.env.seq, 2);
  assert.equal(seat.stateHash(), referee.session.stateHash());
});
