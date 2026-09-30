// The keeper as the source of a timed game's randomness: it signs the tip of
// a hash chain for each game that asks, rolls as soon as it stamps a gamble,
// refuses a game whose tip is not its own, and answers a roll it owed when it
// stopped or one a seat asked for onchain. Node's mock timers drive its clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MOVE_FLAG, MOVE_PLAY_RANDOM, MOVE_REVEAL, MOVE_START, REFEREE, ZERO_SIGNATURE, applySteps, playRandom, publicKey,
  rngChain, signedStep, stateHash, tipHash, verify,
} from '../../sdk/src/index.mjs';
import { KeeperClient } from '../../sdk/src/keeper.mjs';
import { SessionStore, memoryBackend } from '../../sdk/src/store.mjs';
import { GAMBLE } from '../../sdk/examples/counter.mjs';
import { Archive, KeeperError } from '../archive.mjs';
import { startKeeper } from '../server.mjs';
import { CHAIN, CHANNEL, REFEREE_KEY, RNG_SECRET, Session, add, counter, keys, timed } from './fixtures.mjs';

const T0 = 1_000_000;
const ids = { chain_id: CHAIN, channel: CHANNEL, game_id: 7n }, config = { target: 20 };
const referee = { privateKey: REFEREE_KEY, rngSecret: RNG_SECRET };
const open = (backend, options = {}) => Archive.open(backend, { games: [[CHANNEL, counter]], chainId: CHAIN, referee, ...options });
// Seats gamble from real hash chains; the game's randomness comes from the referee's tip.
const chains = [rngChain(0x5eed0n, 8), rngChain(0x5eed1n, 8)];
const rolled = (rng_tip, game_id = 7n) => ({ ...timed(game_id), rng_tips: chains.map(c => c[8]),
  clock: { ...timed().clock, rng_tip } });
const gamble = seat => playRandom({ kind: GAMBLE, amount: 0 }, chains[seat][7]);
const settle = () => new Promise(resolve => setImmediate(resolve));
const rejects = (promise, status, pattern) =>
  assert.rejects(promise, e => e instanceof KeeperError && e.status === status && pattern.test(e.message));
const kinds = async (archive, from = 0) => (await archive.steps(ids, from)).steps.map(s => s.step.kind);

/** A keeper with a registered game that takes its randomness from it, and seat 0's first move stamped. */
async function table(backend, options) {
  const archive = await open(backend, options);
  const { rng_tip } = await archive.tip(ids, config);
  const alice = new Session(counter, rolled(rng_tip));
  await archive.register(alice.export());
  await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
  alice.receive(signedStep((await archive.steps(ids, 0)).steps[0]));
  return { archive, alice };
}

test('the keeper signs one tip per game, from its randomness secret', async () => {
  const archive = await open(memoryBackend());
  const { rng_tip, signature } = await archive.tip(ids, config);
  assert.ok(verify(tipHash(counter, CHAIN, CHANNEL, 7n, rng_tip), signature, publicKey(REFEREE_KEY)));
  assert.equal((await archive.tip(ids, config)).rng_tip, rng_tip);
  assert.notEqual((await archive.tip({ ...ids, game_id: 8n }, config)).rng_tip, rng_tip);
  await rejects(archive.tip(ids, { target: 'x' }), 400, /Invalid config/);
  // A chain is as long as the game may run: no tip for a game too long to be admitted here.
  const short = await open(memoryBackend(), { maxSteps: 64 });
  await rejects(short.tip(ids, config), 409, /can run to 97 steps; this keeper keeps at most 64/);
  // Another secret gives another chain, and no secret gives none.
  const other = await open(memoryBackend(), { referee: { ...referee, rngSecret: 0x1234n } });
  assert.notEqual((await other.tip(ids, config)).rng_tip, rng_tip);
  const plain = await open(memoryBackend(), { referee: { privateKey: REFEREE_KEY } });
  await rejects(plain.tip(ids, config), 404, /gives no randomness/);
  // An anchored game's config comes from its channel, which must have asked this referee.
  let created = { config, clock: { ...timed().clock, rng_tip: 1n } };
  const anchored = await open(memoryBackend(), { created: async () => created });
  assert.equal((await anchored.tip(ids)).rng_tip, rng_tip);
  created = { config, clock: timed().clock };
  await rejects(anchored.tip(ids), 409, /did not ask this referee/);
  created = { config, clock: { ...timed().clock, referee: 0xabcn, rng_tip: 1n } };
  await rejects(anchored.tip(ids), 409, /did not ask this referee/);
  created = { config, clock: null };
  await rejects(anchored.tip(ids), 409, /did not ask this referee/);
});

test('the keeper rolls as soon as it stamps a gamble', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const { archive, alice } = await table(memoryBackend());
  try {
    t.mock.timers.tick(5000);
    const result = await archive.append(ids, 1, [signedStep(alice.sign(gamble(1), keys[1]))]);
    assert.deepEqual([result.accepted, result.seq], [1, 3]);
    // Two steps came of it: the stamped gamble and the referee's roll, which no seat signs.
    const [gambled, roll] = (await archive.steps(ids, 1)).steps;
    assert.deepEqual([gambled.step.kind, roll.step.kind, roll.seat], [MOVE_PLAY_RANDOM, MOVE_REVEAL, REFEREE]);
    assert.deepEqual([roll.stamp, roll.signature], [T0 + 5000, ZERO_SIGNATURE]);
    alice.receive(signedStep(gambled));
    assert.equal(alice.due(), REFEREE);
    alice.receive(signedStep(roll));
    assert.equal(alice.stateHash(), (await archive.session(ids)).stateHash());
    assert.equal(alice.due(), 0);
    // Seat 0's clock runs from the roll: its 90 s, then the flag.
    t.mock.timers.tick(90_000);
    await settle();
    assert.deepEqual(await kinds(archive, 3), []);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(await kinds(archive, 3), [MOVE_FLAG]);
  } finally { archive.stop(); }
});

test('the keeper refuses a game whose randomness tip is not its own', async () => {
  const archive = await open(memoryBackend());
  await rejects(archive.register(new Session(counter, rolled(0xbadn)).export()), 409, /tip is not this referee's/);
  // Without a secret it has no chain to roll from.
  const { rng_tip } = await archive.tip(ids, config);
  const plain = await open(memoryBackend(), { referee: { privateKey: REFEREE_KEY } });
  await rejects(plain.register(new Session(counter, rolled(rng_tip)).export()), 409, /tip is not this referee's/);
  // A game another referee rolls for is archived like any other.
  const theirs = { ...rolled(0xbadn), clock: { ...timed().clock, referee: publicKey(0x999n), rng_tip: 0xbadn } };
  assert.equal((await archive.register(new Session(counter, theirs).export())).created, true);
  assert.equal(archive.referees(ids), false);
});

test('a restarted keeper answers the roll it owed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const backend = memoryBackend();
  let { archive, alice } = await table(backend);
  try {
    archive.stop();
    // The keeper stopped between stamping a gamble and rolling: its store holds the gamble alone.
    const store = new SessionStore(backend), stopped = await store.load(counter, ids);
    stopped.stamp(signedStep(alice.sign(gamble(1), keys[1])), T0 + 1000, REFEREE_KEY);
    await store.save(stopped);
    assert.equal(stopped.due(), REFEREE);
    t.mock.timers.tick(600_000);
    archive = await open(backend);
    assert.deepEqual(await kinds(archive), [0, MOVE_PLAY_RANDOM, MOVE_REVEAL]);
    // Its downtime is nobody's time: the roll is stamped where the clock stopped.
    assert.equal((await archive.steps(ids, 2)).steps[0].stamp, T0 + 1000);
  } finally { archive.stop(); }
});

test('a roll asked for onchain is answered when the channel resumes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  let anchor = null;
  const { archive, alice } = await table(memoryBackend(), { anchorHash: async () => anchor });
  try {
    // A dispute ends in forced play, where seat 1 gambles onchain: the channel's anchor waits for the referee.
    assert.equal(await archive.forced(ids, 1), true);
    const waiting = applySteps(counter, alice.context, alice.terms, alice.env, null, [gamble(1)]);
    anchor = stateHash(counter, waiting);
    const seat = new Session(counter, alice.terms, { start: waiting });
    assert.equal((await archive.register(seat.export())).reanchored, true);
    // Nothing is stamped while the channel is in forced play.
    assert.deepEqual(await kinds(archive, 2), []);
    t.mock.timers.tick(50_000);
    // The referee returns the game to offchain play, and rolls at once.
    assert.equal(await archive.resumed(ids, 2), true);
    const [roll] = (await archive.steps(ids, 2)).steps;
    assert.deepEqual([roll.step.kind, roll.seat], [MOVE_REVEAL, REFEREE]);
    seat.receive(signedStep(roll));
    assert.equal(seat.due(), 0);
    // The start still follows the grace, so the wait is charged to no one.
    t.mock.timers.tick(120_000);
    await settle();
    assert.deepEqual(await kinds(archive, 2), [MOVE_REVEAL, MOVE_START]);
  } finally { archive.stop(); }
});

test('clients fetch the referee\'s signed tip over HTTP', async () => {
  const k = await startKeeper({
    chain_id: 'SN_TEST', chain: CHAIN, port: 0, host: '127.0.0.1', poll_seconds: 0, max_open_games: 10, max_steps: 128,
    max_body_bytes: 1 << 20, rate_per_minute: 120, max_wait_seconds: 5, max_waiters: 10, cors_origin: '*', referee,
    entries: new Map([[CHANNEL, { channel: CHANNEL, game: counter, entrypoints: {}, replay_max_steps: 64, prover: null }]]),
  }, { backend: memoryBackend(), log: () => {} });
  try {
    assert.equal(k.info().randomness, true);
    const { rng_tip, signature } = await new KeeperClient(k.url).tip(ids, { config });
    assert.ok(verify(tipHash(counter, CHAIN, CHANNEL, 7n, rng_tip), signature, publicKey(REFEREE_KEY)));
    assert.equal(rng_tip, (await k.archive.tip(ids, config)).rng_tip);
  } finally { await k.close(); }
});
