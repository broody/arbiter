// Protocol v6 in the SDK: a timed game's clock keeps its first stamp
// (`started`), which the referee attests with the rest of the clock. The Cairo
// side pins the same rule (examples/counter/src/clock_tests.cairo,
// `the_first_stamp_is_when_the_game_started`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROTOCOL_VERSION, applySteps, contextHash, encodeClock, open, play, publicKey, start, stateHash, tag,
} from '../src/index.mjs';
import { ADD, counter } from '../examples/counter.mjs';

const keys = [0x1a2b3cn, 0x4d5e6fn];
const settings = { turn_ms: 30000, bank_ms: 60000, increment_ms: 0, byoyomi: null };
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 6n, prover: 0xad0b7e5n, response_seconds: 3600,
  clock: { referee: publicKey(0x7e7e7en), settings, rng_tip: 0n },
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: [0x11n, 0x22n], config: { target: 20 },
};
const context = contextHash(counter, terms);
const add = amount => play({ kind: ADD, amount });
const run = (steps, stamps, from = open(counter, terms)) => applySteps(counter, context, terms, from, null, steps, stamps);

test('protocol v6', () => assert.equal(PROTOCOL_VERSION, 6n));

test('the first stamp is when the game started', () => {
  assert.equal(open(counter, terms).clock.started, 0);
  assert.equal(run([add(3), add(3)], [1000, 2000]).clock.started, 1000);
  assert.equal(run([start(), add(3)], [700, 41000]).clock.started, 700);
  // A restart and a pause keep it.
  const restarted = run([add(3), start(), add(3)], [1000, 50000, 51000]);
  assert.equal(restarted.clock.started, 1000);
  // An unstamped step, as forced play applies it.
  const forced = run([add(3)], [], restarted);
  assert.deepEqual([forced.clock.stamp, forced.clock.started], [0, 1000]);
  assert.equal(run([add(3)], [90000], forced).clock.started, 1000);
});

test('the start is part of the clock the referee attests', () => {
  const a = run([add(3)], [1000]), b = run([add(3)], [2000]);
  // Same clocks but for when they started: different encodings and states.
  assert.deepEqual({ ...a.clock, stamp: 0, started: 0 }, { ...b.clock, stamp: 0, started: 0 });
  assert.notDeepEqual(encodeClock(counter, a.clock), encodeClock(counter, { ...a.clock, started: 2000 }));
  assert.notEqual(stateHash(counter, a), stateHash(counter, { ...a, clock: { ...a.clock, started: 999 } }));
});
