// The keeper as the referee of timed games: it stamps steps as they arrive,
// starts a clock nobody started, flags a seat whose time runs out, never stamps
// a second branch, does not charge seats for its own downtime or for forced
// play, and never flags a seat its step cap stops. Node's mock timers drive
// its clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVE_FLAG, MOVE_START, REASON_TIMEOUT, hex, publicKey, resign, signedStep } from '../../sdk/src/index.mjs';
import { KeeperClient } from '../../sdk/src/keeper.mjs';
import { SessionStore, memoryBackend } from '../../sdk/src/store.mjs';
import { Archive, KeeperError } from '../archive.mjs';
import { startKeeper } from '../server.mjs';
import { CHAIN, CHANNEL, REFEREE_KEY, Session, add, counter, keys, timed } from './fixtures.mjs';

const T0 = 1_000_000;
// A seat's time runs out 90 s after its turn starts (see `timed`).
const ids = { chain_id: CHAIN, channel: CHANNEL, game_id: 7n };
const open = (backend, options = {}) =>
  Archive.open(backend, { games: [[CHANNEL, counter]], chainId: CHAIN, referee: { privateKey: REFEREE_KEY }, ...options });
// Let a fired timer's save and wake settle.
const settle = () => new Promise(resolve => setImmediate(resolve));
const rejects = (promise, status, pattern) =>
  assert.rejects(promise, e => e instanceof KeeperError && e.status === status && pattern.test(e.message));
// The kinds of the archived steps (MOVE_PLAY is 0).
const kinds = async archive => (await archive.session(ids)).steps.map(s => s.step.kind);

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
    chain_id: 'SN_TEST', chain: CHAIN, port: 0, host: '127.0.0.1', poll_seconds: 0, max_open_games: 10, max_steps: 128,
    max_body_bytes: 1 << 20, rate_per_minute: 120, max_wait_seconds: 5, max_waiters: 10, cors_origin: '*',
    referee: { privateKey: REFEREE_KEY },
    entries: new Map([[CHANNEL, { channel: CHANNEL, game: counter, entrypoints: {}, replay_max_steps: 64, prover: null }]]),
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

    // Bob signs two steps ahead: he plays, then resigns.
    await bobStore.move(bob, add(2), keys[1]);
    await bobStore.move(bob, resign(1), keys[1]);
    assert.equal((await client.submit(bob, { store: bobStore })).length, 2);
    assert.deepEqual([bob.pending, bob.env.seq], [[], 3]);
    await client.pull(alice, { store: aliceStore });
    assert.equal(alice.stateHash(), bob.stateHash());
  } finally { await k.close(); }
});

test('the referee starts a clock nobody started after the start grace, then flags on time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const archive = await open(memoryBackend());
  try {
    const alice = new Session(counter, timed());
    await archive.register(alice.export());
    // Seat 0 never moves: the clock starts 120 s after the keeper learned of the game.
    t.mock.timers.tick(119_999);
    await settle();
    assert.deepEqual(await kinds(archive), []);
    t.mock.timers.tick(1);
    await settle();
    const [started] = (await archive.steps(ids, 0)).steps;
    assert.deepEqual([started.step.kind, started.stamp], [MOVE_START, T0 + 120_000]);
    alice.receive(signedStep(started));
    // From the start, seat 0 has its 90 s.
    t.mock.timers.tick(90_000);
    await settle();
    assert.deepEqual(await kinds(archive), [MOVE_START]);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(await kinds(archive), [MOVE_START, MOVE_FLAG]);
    alice.receive(signedStep((await archive.steps(ids, 1)).steps[0]));
    assert.deepEqual(alice.env.outcome, { finished: true, winner: 2, reason: REASON_TIMEOUT });
  } finally { archive.stop(); }
});

test('after forced play, the clock restarts without charging the forced period, and flags wait for it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const archive = await open(memoryBackend());
  try {
    const alice = new Session(counter, timed());
    await archive.register(alice.export());
    await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
    alice.receive(signedStep((await archive.steps(ids, 0)).steps[0]));
    // A dispute nobody acknowledged ends in forced play at epoch 1: no clock runs here, and nothing is stamped.
    t.mock.timers.tick(10_000);
    assert.equal(await archive.forced(ids, 1), true);
    assert.equal(await archive.forced(ids, 1), false);
    const bob = signedStep(alice.sign(add(2), keys[1]));
    await rejects(archive.append(ids, 1, [bob]), 409, /forced play/);
    t.mock.timers.tick(200_000);
    await settle();
    // The channel resumes at epoch 2. Bob's last stamp is 210 s old, yet he isn't flagged.
    assert.equal(await archive.resumed(ids, 2), true);
    t.mock.timers.tick(60_000);
    await settle();
    assert.deepEqual(await kinds(archive), [0]);
    // His step, signed before the resume, arrives before the start grace ends:
    // it is stamped at the last stamp, so the forced period is charged to no one.
    assert.equal((await archive.append(ids, 1, [bob])).accepted, 1);
    assert.equal((await archive.steps(ids, 1)).steps[0].stamp, T0);
    alice.receive(signedStep((await archive.steps(ids, 1)).steps[0]));
    // No start follows, however often the resume is reported.
    assert.equal(await archive.resumed(ids, 2), false);
    // Alice's clock runs from Bob's step: her 90 s, then the flag.
    t.mock.timers.tick(90_000);
    await settle();
    assert.deepEqual(await kinds(archive), [0, 0]);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(await kinds(archive), [0, 0, MOVE_FLAG]);
    assert.equal((await archive.steps(ids, 2)).steps[0].stamp, T0 + 90_001);
  } finally { archive.stop(); }
});

test('after forced play with nobody moving, the start comes after the grace, once per epoch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const backend = memoryBackend();
  let archive = await open(backend);
  try {
    const alice = new Session(counter, timed());
    await archive.register(alice.export());
    await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
    await archive.forced(ids, 1);
    t.mock.timers.tick(500_000);
    await archive.resumed(ids, 2);
    // A restart keeps the pending start, and the suspended flag.
    archive.stop();
    archive = await open(backend);
    t.mock.timers.tick(119_999);
    await settle();
    assert.deepEqual(await kinds(archive), [0]);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(await kinds(archive), [0, MOVE_START]);
    archive.stop();
    archive = await open(backend);
    assert.equal(await archive.resumed(ids, 2), false);
    t.mock.timers.tick(90_000);
    await settle();
    assert.deepEqual(await kinds(archive), [0, MOVE_START]);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(await kinds(archive), [0, MOVE_START, MOVE_FLAG]);
  } finally { archive.stop(); }
});

test('a seat whose step the step cap refuses is never flagged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const backend = memoryBackend();
  let archive = await open(backend);
  const alice = new Session(counter, timed());
  await archive.register(alice.export());
  await archive.append(ids, 0, [signedStep(alice.sign(add(3), keys[0]))]);
  alice.receive(signedStep((await archive.steps(ids, 0)).steps[0]));
  archive.stop();
  // The operator lowers the cap to 2 steps.
  archive = await open(backend, { games: [[CHANNEL, { game: counter, maxSteps: 2 }]] });
  try {
    assert.ok(archive.referees(ids));
    await archive.append(ids, 1, [signedStep(alice.sign(add(2), keys[1]))]);
    alice.receive(signedStep((await archive.steps(ids, 1)).steps[0]));
    // The transcript is full: Alice's step is refused, and nobody referees the game any more.
    await rejects(archive.append(ids, 2, [signedStep(alice.sign(add(1), keys[0]))]), 400, /limited to 2 steps/);
    assert.equal(archive.referees(ids), false);
    t.mock.timers.tick(3_600_000);
    await settle();
    assert.deepEqual(await kinds(archive), [0, 0]);
  } finally { archive.stop(); }
});
