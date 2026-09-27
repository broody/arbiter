// Latency a referee adds, measured on this machine:
// - the SDK work per step: a seat's signature, the referee's stamp (verify,
//   apply, attest), and a client applying a stamped step (two verifications);
// - through a keeper that referees the game, the time from a seat posting a
//   step to the other seat's stream applying it, early in a game and after
//   hundreds of steps, with the memory and the file store.
//
//   node keeper/bench.mjs [STEPS]      (default 400)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { counter } from '../sdk/examples/counter.mjs';
import { Referee, Session, actionHash, publicKey, recommit, sign, signedStep, tag, verify } from '../sdk/src/index.mjs';
import { KeeperClient } from '../sdk/src/keeper.mjs';
import { memoryBackend } from '../sdk/src/store.mjs';
import { fileBackend } from '../sdk/src/store-file.mjs';
import { startKeeper } from './server.mjs';

const STEPS = Number(process.argv[2] ?? 400);
const keys = [0x1a2b3cn, 0x4d5e6fn], REFEREE_KEY = 0x7e7e7en, CHANNEL = 0xc4a11e1n;
const settings = { turn_ms: 600000, bank_ms: 0, increment_ms: 0, byoyomi: null };
const terms = (clock, game_id = 7n) => ({
  chain_id: tag('SN_TEST'), channel: CHANNEL, game_id, prover: 0xad0b7e5n, response_seconds: 3600, clock,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: [0x11n, 0x22n], config: { target: 20 },
});
const timed = terms({ referee: publicKey(REFEREE_KEY), settings });
// Seat 0 recommits its chain again and again: a game that never ends.
const step = i => recommit(BigInt(i + 1000));

const ms = ns => Number(ns) / 1e6;
const stats = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `p50 ${at(0.5).toFixed(2)} ms, p90 ${at(0.9).toFixed(2)} ms, max ${sorted.at(-1).toFixed(2)} ms`;
};
function time(label, n, fn) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    fn(i);
    samples.push(ms(process.hrtime.bigint() - start));
  }
  console.log(`${label.padEnd(44)} ${stats(samples)}`);
}

console.log(`== SDK, per step (${STEPS} steps)`);
const message = actionHash(counter, 1n, 0, 0n, step(0));
const signature = sign(message, keys[0]);
time('ECDSA sign', 200, () => sign(message, keys[0]));
time('ECDSA verify', 200, () => verify(message, signature, publicKey(keys[0])));
{
  const seat = new Session(counter, terms(null)), follower = new Session(counter, terms(null));
  const signed = [];
  time('untimed: seat signs', STEPS, i => signed.push(seat.move(step(i), keys[0])));
  time('untimed: client applies (1 verify)', STEPS, i => follower.receive(signedStep(signed[i])));
}
{
  const seat = new Session(counter, timed), follower = new Session(counter, timed);
  const referee = new Referee(new Session(counter, timed), REFEREE_KEY, { now: 1 });
  const stamped = [];
  let now = 1;
  const signed = [];
  for (let i = 0; i < STEPS; i++) {
    signed.push(signedStep(seat.sign(step(i), keys[0])));
    seat.receive(signedStep(referee.session.stamp(signed[i], (now += 10), REFEREE_KEY)));
  }
  const fresh = new Referee(new Session(counter, timed), REFEREE_KEY, { now: 1 });
  now = 1;
  time('timed: referee stamps (verify, apply, sign)', STEPS, i => stamped.push(fresh.stamp(signed[i], (now += 10))));
  time('timed: client applies (2 verifies)', STEPS, i => follower.receive(signedStep(stamped[i])));
}

// Through a keeper: seat 0 posts each step; seat 1's stream applies it.
async function keeper(label, backend) {
  const k = await startKeeper({
    chain_id: 'SN_TEST', chain: tag('SN_TEST'), port: 0, host: '127.0.0.1', poll_seconds: 0, max_games: 10,
    max_steps: STEPS + 16, max_body_bytes: 1 << 24, rate_per_minute: 1e9, max_wait_seconds: 30, max_waiters: 10,
    cors_origin: '*', heartbeat_seconds: 15, referee: { privateKey: REFEREE_KEY },
    entries: new Map([[CHANNEL, { channel: CHANNEL, game: counter, entrypoints: {}, max_history_steps: 64, prover: null }]]),
  }, { backend, log: () => {} });
  const client = new KeeperClient(k.url);
  const seat = new Session(counter, timed), follower = new Session(counter, timed);
  await client.register(seat);
  const stop = new AbortController();
  let arrived = null;
  const following = client.follow(follower, { signal: stop.signal, onSteps: () => arrived?.() });
  await new Promise(resolve => setTimeout(resolve, 50));
  const samples = [];
  for (let i = 0; i < STEPS; i++) {
    const landed = new Promise(resolve => { arrived = resolve; });
    const start = process.hrtime.bigint();
    seat.sign(step(i), keys[0]);
    await client.submit(seat);
    await landed;
    samples.push(ms(process.hrtime.bigint() - start));
  }
  stop.abort();
  await following;
  await k.close();
  const tenth = Math.max(1, Math.floor(STEPS / 10));
  console.log(`${label}: first ${tenth} steps   ${stats(samples.slice(0, tenth))}`);
  console.log(`${label}: last ${tenth} steps    ${stats(samples.slice(-tenth))}`);
}

console.log(`\n== Keeper as referee: post a step -> the other seat's stream applies it (${STEPS} steps)`);
await keeper('memory store', memoryBackend());
const dir = await mkdtemp(join(tmpdir(), 'referee-bench-'));
try { await keeper('file store  ', await fileBackend(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
