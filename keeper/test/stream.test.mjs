// The keeper's step stream (server-sent events) through KeeperClient.follow:
// steps arrive as the keeper gets them, stamps and flags included, and the
// stream counts against the waiting-client limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVE_FLAG, publicKey } from '../../sdk/src/index.mjs';
import { KeeperClient } from '../../sdk/src/keeper.mjs';
import { SessionStore, memoryBackend } from '../../sdk/src/store.mjs';
import { startKeeper } from '../server.mjs';
import { CHAIN, CHANNEL, Session, add, counter, keys, terms } from './fixtures.mjs';

const REFEREE_KEY = 0x7e7e7en;

async function keeper(overrides = {}) {
  const k = await startKeeper({
    chain_id: 'SN_TEST', chain: CHAIN, port: 0, host: '127.0.0.1', poll_seconds: 0, max_games: 10, max_steps: 64,
    max_body_bytes: 1 << 20, rate_per_minute: 1000, max_wait_seconds: 5, max_waiters: 10, cors_origin: '*',
    heartbeat_seconds: 0.02, referee: { privateKey: REFEREE_KEY },
    entries: new Map([[CHANNEL, { channel: CHANNEL, game: counter, entrypoints: {}, max_history_steps: 64, prover: null }]]),
    ...overrides,
  }, { backend: memoryBackend(), log: () => {} });
  return { ...k, client: new KeeperClient(k.url) };
}

/** Follow `session` until `until(session)` holds, then stop; resolves with every batch seen. */
function follow(client, session, until, options = {}) {
  const controller = new AbortController(), batches = [];
  const done = client.follow(session, { ...options, signal: controller.signal, onSteps: records => {
    batches.push(records.map(r => r.seq));
    if (until(session)) controller.abort();
  } });
  return done.then(() => batches);
}

test('a follower gets each step as the keeper does', async () => {
  const k = await keeper();
  try {
    const alice = new Session(counter, terms()), bob = new Session(counter, terms());
    alice.move(add(3), keys[0]);
    await k.client.register(alice);
    const seen = follow(k.client, bob, s => s.env.seq === 3);
    // Heartbeats pass while nothing happens.
    await new Promise(resolve => setTimeout(resolve, 60));
    alice.move(add(2), keys[1]);
    alice.move(add(1), keys[0]);
    await k.client.send(alice, 1);
    assert.deepEqual((await seen).flat(), [0, 1, 2]);
    assert.equal(bob.stateHash(), alice.stateHash());
  } finally { await k.close(); }
});

test('our own steps echoed back are skipped', async () => {
  const k = await keeper();
  try {
    const alice = new Session(counter, terms());
    await k.client.register(alice);
    const seen = follow(k.client, alice, s => s.env.seq === 2);
    alice.move(add(3), keys[0]);
    await k.client.send(alice, 0);
    alice.move(add(2), keys[1]);
    await k.client.send(alice, 1);
    // Alice applied both before the keeper streamed them back, in one batch or two.
    assert.deepEqual((await seen).flat(), []);
    assert.equal(alice.env.seq, 2);
  } finally { await k.close(); }
});

test('a timed game streams its stamps and its flag', async () => {
  const k = await keeper();
  try {
    const timed = { ...terms(), clock: { referee: publicKey(REFEREE_KEY), turn_ms: 150, bank_ms: 0, increment_ms: 0 } };
    const aliceStore = new SessionStore(memoryBackend());
    const alice = await aliceStore.open(counter, timed), watcher = new Session(counter, timed);
    await k.client.register(alice);
    const seen = follow(k.client, watcher, s => s.env.outcome.finished);
    await aliceStore.move(alice, add(3), keys[0]);
    await k.client.submit(alice, { store: aliceStore });
    // Bob never answers: the keeper flags him after his 150 ms.
    const batches = await seen;
    assert.deepEqual(batches.flat(), [0, 1]);
    assert.equal(watcher.steps[1].step.kind, MOVE_FLAG);
    assert.equal(watcher.env.outcome.winner, 1);
  } finally { await k.close(); }
});

test('streams answer errors as JSON and count as waiting clients', async () => {
  const k = await keeper({ max_waiters: 1 });
  try {
    const session = new Session(counter, terms());
    await assert.rejects(k.client.follow(session), e => e.status === 404 && /Unknown game/.test(e.message));
    await k.client.register(session);
    const controller = new AbortController();
    const first = k.client.follow(new Session(counter, terms()), { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(k.client.follow(new Session(counter, terms())), e => e.status === 503);
    controller.abort();
    await first;
  } finally { await k.close(); }
});
