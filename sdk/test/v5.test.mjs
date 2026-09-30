// Protocol v5 in the SDK: randomness from the referee. A game whose terms
// carry the referee's hash-chain tip waits for the referee's roll where the
// rules name a seat, and that wait is nobody's time. The Cairo side replays
// the same rules (examples/counter/src/clock_tests.cairo) and the fixtures pin
// the hashes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REFEREE, Referee, RngChain, Session, applySteps, contextHash, flag, flagAt, open, play, playRandom, publicKey,
  resign, reveal, rngChain, sign, start, stateHash, tag, tipHash, verify, voidHash,
} from '../src/index.mjs';
import { ADD, GAMBLE, counter } from '../examples/counter.mjs';

const keys = [0x1a2b3cn, 0x4d5e6fn], refereeKey = 0x7e7e7en;
const chains = [rngChain(0x5eed0n, 8), rngChain(0x5eed1n, 8)];
const refereeChain = () => new RngChain(0x5eed7en, 8);
const rolls = rngChain(0x5eed7en, 8); // rolls[7] is the referee's first value, rolls[6] its second
const settings = { turn_ms: 30000, bank_ms: 60000, increment_ms: 0, byoyomi: null };
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 5n, prover: 0xad0b7e5n, response_seconds: 3600,
  clock: { referee: publicKey(refereeKey), settings, rng_tip: rolls[8] },
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: chains.map(c => c[8]), config: { target: 20 },
};
const seatsReveal = { ...terms, clock: { ...terms.clock, rng_tip: 0n } };
const context = contextHash(counter, terms);
const add = amount => play({ kind: ADD, amount });
const gamble = seat => playRandom({ kind: GAMBLE, amount: 0 }, chains[seat][7]);
const run = (steps, stamps = [], t = terms) => applySteps(counter, contextHash(counter, t), t, open(counter, t), null, steps, stamps);
const T0 = 1_000_000;

test('a gamble waits for the referee when the terms carry its tip', () => {
  assert.equal(open(counter, terms).rng_referee, rolls[8]);
  assert.equal(open(counter, seatsReveal).rng_referee, 0n);
  // The counter's rules name the other seat; the terms have the referee reveal.
  const waiting = run([add(3), gamble(1)], [1000, 2000]);
  assert.deepEqual([waiting.pending.active, waiting.pending.seat], [true, REFEREE]);
  assert.equal(run([add(3), gamble(1)], [1000, 2000], seatsReveal).pending.seat, 0);
  const rolled = run([add(3), gamble(1), reveal(rolls[7])], [1000, 2000, 2000]);
  assert.equal(rolled.pending.active, false);
  assert.equal(rolled.rng_referee, rolls[7]);
  assert.equal(rolled.game.next, 0);
  // Only the referee's next value is a roll: not a seat's, not a later one.
  assert.throws(() => run([add(3), gamble(1), reveal(chains[0][7])], [1000, 2000, 3000]), /Invalid reveal/);
  assert.throws(() => run([add(3), gamble(1), reveal(rolls[6])], [1000, 2000, 3000]), /Invalid reveal/);
});

test('a pending roll is nobody\'s time', () => {
  // The roll comes long after either seat's time would have run out.
  const late = run([add(3), gamble(1), reveal(rolls[7])], [1000, 2000, 200000]);
  assert.deepEqual(late.clock, { seats: { banks: [60000, 60000], periods: [] }, used: 0, stamp: 200000 });
  assert.throws(() => run([add(3), gamble(1), reveal(rolls[7])], [1000, 2000, 1999]), /Stamp out of order/);
  // Nobody is flagged meanwhile, but a seat may still resign.
  const waiting = run([add(3), gamble(1)], [1000, 2000]);
  assert.equal(flagAt(counter, terms, waiting), null);
  assert.throws(() => run([add(3), gamble(1), flag()], [1000, 2000, 999999]), /Roll pending/);
  const resigned = run([add(3), gamble(1), resign(0)], [1000, 2000, 999999]);
  assert.equal(resigned.outcome.winner, 2);
  assert.deepEqual(resigned.clock.seats.banks, [60000, 60000]);
});

test('referee steps are not signer changes', () => {
  // Seat 0, seat 1, the referee's roll, seat 0: three changes of seat.
  const env = run([add(3), gamble(1), reveal(rolls[7]), add(1)], [1000, 2000, 2000, 3000]);
  assert.deepEqual([env.support_turn, env.last_seat], [3, 0]);
  const started = run([start(), add(3), start(), add(3)], [1, 2, 3, 4]);
  assert.deepEqual([started.support_turn, started.last_seat], [2, 1]);
});

test('an unstamped roll resolves a forced gamble, as anyone may post it onchain', () => {
  const forced = applySteps(counter, context, terms, run([add(3)], [1000]), null, [gamble(1)]);
  assert.deepEqual([forced.pending.seat, forced.clock.stamp], [REFEREE, 0]);
  const rolled = applySteps(counter, context, terms, forced, null, [reveal(rolls[7])]);
  assert.deepEqual([rolled.pending.active, rolled.clock.stamp, rolled.game.next], [false, 0, 0]);
  // The referee's other steps still need a stamp.
  assert.throws(() => applySteps(counter, context, terms, forced, null, [start()]), /Referee step needs a stamp/);
});

test('the Referee rolls as soon as it stamps a gamble, and the seats follow', () => {
  const referee = new Referee(new Session(counter, terms), refereeKey, { now: T0, rng: refereeChain() });
  const seat = new Session(counter, terms);
  seat.receive(referee.stamp(seat.sign(add(3), keys[0]), T0));
  const stamped = referee.stamp(seat.sign(gamble(1), keys[1]), T0 + 5000);
  assert.equal(stamped.seat, 1);
  // The roll is the referee's next record: stamped with the gamble, signed by no seat.
  const [gambled, rolled] = referee.session.steps.slice(-2);
  assert.equal(gambled, stamped);
  assert.deepEqual([rolled.seat, rolled.stamp, rolled.step.value], [REFEREE, T0 + 5000, rolls[7]]);
  assert.equal(referee.roll(T0 + 5000), null);
  seat.receive(gambled);
  assert.equal(seat.due(), REFEREE);
  assert.throws(() => seat.sign(add(1), keys[0]), /Reveal pending/);
  seat.receive(rolled);
  assert.equal(seat.stateHash(), referee.session.stateHash());
  assert.equal(seat.due(), 0);
  // A roll no referee attested is refused, even with the right value.
  const forged = new Session(counter, terms);
  for (const record of referee.session.steps.slice(0, 2)) forged.receive(record);
  assert.throws(() => forged.receive({ ...rolled, attestation: gambled.attestation }), /Invalid referee attestation/);
});

test('a Referee picks up a roll it owes, given its chain', () => {
  const live = new Referee(new Session(counter, terms), refereeKey, { now: T0 });
  const seat = new Session(counter, terms);
  seat.receive(live.stamp(seat.sign(add(3), keys[0]), T0));
  // Without its chain the referee refuses a gamble: it could not answer it.
  const gambled = seat.sign(gamble(1), keys[1]);
  assert.throws(() => live.stamp(gambled, T0 + 1000), /No hash-chain value for this roll/);
  assert.equal(live.session.due(), 1);
  // A gamble stamped without its roll, as when the referee stops in between.
  live.session.stamp(gambled, T0 + 1000, refereeKey);
  assert.equal(live.session.due(), REFEREE);
  assert.throws(() => live.roll(T0 + 2000), /No hash-chain value for this roll/);
  // A restarted referee with the chain rolls at once.
  const restarted = new Referee(Session.import(counter, live.session.export()), refereeKey, { now: T0 + 60000, rng: refereeChain() });
  const rolled = restarted.roll(T0 + 60000);
  assert.deepEqual([rolled.seat, rolled.step.value], [REFEREE, rolls[7]]);
  assert.equal(restarted.session.due(), 0);
});

test('a chain kept as checkpoints finds every value', () => {
  const full = rngChain(0xabcdn, 200);
  for (const every of [1, 7, 64, 200, 500]) {
    const chain = new RngChain(0xabcdn, 200, every);
    assert.equal(chain.tip, full[200]);
    for (let i = 200; i >= 1; i--) assert.equal(chain.before(full[i]), full[i - 1]);
    assert.equal(chain.before(full[93]), full[92]);
    assert.equal(chain.before(full[0]), null);
    assert.equal(chain.before(0x1234n), null);
  }
});

test('the referee signs its tip for one game, and the seats sign a void', () => {
  const key = publicKey(refereeKey), tip = rolls[8];
  const message = tipHash(counter, terms.chain_id, terms.channel, terms.game_id, tip);
  assert.ok(verify(message, sign(message, refereeKey), key));
  assert.notEqual(message, tipHash(counter, terms.chain_id, terms.channel, 6n, tip));
  const state = stateHash(counter, open(counter, terms));
  const voided = voidHash(counter, context, 1, state);
  assert.ok(verify(voided, sign(voided, keys[0]), publicKey(keys[0])));
  assert.notEqual(voided, voidHash(counter, context, 2, state));
});
