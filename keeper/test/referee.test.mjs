// The keeper as the referee of timed games: it stamps steps as they arrive,
// flags a seat whose time runs out, never stamps a second branch, and does not
// charge seats for its own downtime. Node's mock timers drive its clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVE_FLAG, REASON_TIMEOUT, hex, publicKey, recommit, signedStep } from '../../sdk/src/index.mjs';
import { KeeperClient } from '../../sdk/src/keeper.mjs';
import { SessionStore, memoryBackend } from '../../sdk/src/store.mjs';
import { Archive, KeeperError } from '../archive.mjs';
import { startKeeper } from '../server.mjs';
import { CHAIN, CHANNEL, Session, add, counter, keys, terms } from './fixtures.mjs';

const REFEREE_KEY = 0x7e7e7en, T0 = 1_000_000;
// 30 s per turn and a 60 s bank: a seat's time runs out 90 s after its turn starts.
const timed = (game_id = 7n) => ({ ...terms(game_id),
  clock: { referee: publicKey(REFEREE_KEY), settings: { turn_ms: 30000, bank_ms: 60000, increment_ms: 0, byoyomi: null } } });
const ids = { chain_id: CHAIN, channel: CHANNEL, game_id: 7n };
const open = (backend, options = {}) =>
  Archive.open(backend, { games: [[CHANNEL, counter]], chainId: CHAIN, referee: { privateKey: REFEREE_KEY }, ...options });
// Let a fired timer's save and wake settle.
const settle = () => new Promise(resolve => setImmediate(resolve));
const rejects = (promise, status, pattern) =>
  assert.rejects(promise, e => e instanceof KeeperError && e.status === status && pattern.test(e.message));

test('the keeper stamps a timed game\'s steps and flags a seat that runs out of time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const archive = await open(memoryBackend());
  try {
    const alice = new Session(counter, timed());
    await archive.register(alice.export());
    assert.ok(archive.referees(ids));
    await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
    const [stamped] = (await archive.steps(ids, 0)).steps;
    assert.equal(stamped.stamp, T0);
    alice.receive(signedStep(stamped));

    // Bob never answers.
    t.mock.timers.tick(90000);
    await settle();
    assert.equal((await archive.steps(ids, 1)).steps.length, 0);
    t.mock.timers.tick(1);
    await settle();
    const [flagged] = (await archive.steps(ids, 1)).steps;
    assert.equal(flagged.step.kind, MOVE_FLAG);
    alice.receive(signedStep(flagged));
    assert.deepEqual(alice.env.outcome, { finished: true, winner: 1, reason: REASON_TIMEOUT });
  } finally { archive.stop(); }
});

test('a step that arrives after its seat\'s time ran out is refused and flagged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const archive = await open(memoryBackend());
  try {
    const alice = new Session(counter, timed());
    await archive.register(alice.export());
    await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
    alice.receive(signedStep((await archive.steps(ids, 0)).steps[0]));
    // Bob's step arrives before the flag timer has run.
    t.mock.timers.setTime(T0 + 95000);
    await rejects(archive.append(ids, 1, [signedStep(alice.sign(add(3), keys[1]))]), 400, /Step 1 rejected: Flag fell/);
    const session = await archive.session(ids);
    assert.equal(session.env.outcome.reason, REASON_TIMEOUT);
    assert.equal(session.steps.at(-1).stamp, T0 + 95000);
  } finally { archive.stop(); }
});

test('the referee never stamps a second step at one seq', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const archive = await open(memoryBackend());
  try {
    const alice = new Session(counter, timed());
    await archive.register(alice.export());
    await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
    // Seat 0 signs another step at seq 0: stored as evidence, never stamped.
    const other = new Session(counter, timed());
    await rejects(archive.append(ids, 0, [signedStep(other.sign(add(2), keys[0]))]), 409, /Conflicts/);
    assert.equal((await archive.evidence(ids)).length, 1);
    assert.equal((await archive.session(ids)).steps.length, 1);
  } finally { archive.stop(); }
});

test('a restarted referee resumes the clock where it stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const backend = memoryBackend();
  let archive = await open(backend);
  const alice = new Session(counter, timed());
  await archive.register(alice.export());
  await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
  archive.stop();
  // Down for an hour.
  t.mock.timers.setTime(T0 + 3_600_000);
  archive = await open(backend);
  try {
    t.mock.timers.tick(90000);
    await settle();
    assert.equal((await archive.session(ids)).env.outcome.finished, false);
    t.mock.timers.tick(1);
    await settle();
    assert.equal((await archive.session(ids)).env.outcome.reason, REASON_TIMEOUT);
  } finally { archive.stop(); }
});

test('a keeper that is not the referee takes only stamped steps', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const referee = await open(memoryBackend());
  const other = await Archive.open(memoryBackend(), { games: [[CHANNEL, counter]], chainId: CHAIN });
  try {
    const alice = new Session(counter, timed());
    await referee.register(alice.export());
    await other.register(alice.export());
    assert.equal(other.referees(ids), false);
    const step = signedStep(alice.sign(add(3), keys[0]));
    await rejects(other.append(ids, 0, [step]), 400, /stamp on every step/);
    await referee.append(ids, 0, [step]);
    assert.equal((await other.append(ids, 0, (await referee.steps(ids, 0)).steps.map(signedStep))).accepted, 1);
  } finally { referee.stop(); }
});

test('clients submit a timed step and pull it back stamped', async () => {
  const k = await startKeeper({
    chain_id: 'SN_TEST', chain: CHAIN, port: 0, host: '127.0.0.1', poll_seconds: 0, max_games: 10, max_steps: 64,
    max_body_bytes: 1 << 20, rate_per_minute: 120, max_wait_seconds: 5, max_waiters: 10, cors_origin: '*',
    referee: { privateKey: REFEREE_KEY },
    entries: new Map([[CHANNEL, { channel: CHANNEL, game: counter, entrypoints: {}, max_history_steps: 64, prover: null }]]),
  }, { backend: memoryBackend(), log: () => {} });
  try {
    assert.equal(k.info().referee, hex(publicKey(REFEREE_KEY)));
    const client = new KeeperClient(k.url);
    const aliceStore = new SessionStore(memoryBackend()), bobStore = new SessionStore(memoryBackend());
    const alice = await aliceStore.open(counter, timed()), bob = await bobStore.open(counter, timed());
    await client.register(alice);
    const record = await aliceStore.move(alice, add(3), keys[0]);
    assert.equal(alice.env.seq, 0);
    const applied = await client.submit(alice, { store: aliceStore });
    assert.equal(applied.length, 1);
    assert.ok(alice.steps[0].stamp > 0);
    await client.pull(bob, { store: bobStore });
    assert.equal(bob.stateHash(), alice.stateHash());

    // Bob signs a whole turn ahead, recommitting his chain and then playing.
    await bobStore.move(bob, recommit(0x33n), keys[1]);
    await bobStore.move(bob, add(2), keys[1]);
    assert.equal((await client.submit(bob, { store: bobStore })).length, 2);
    assert.deepEqual([bob.pending, bob.env.seq], [[], 3]);
    await client.pull(alice, { store: aliceStore });
    assert.equal(alice.stateHash(), bob.stateHash());
  } finally { await k.close(); }
});
