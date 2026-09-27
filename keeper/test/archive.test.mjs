// The keeper's archive: verified registration, appends, branch choice and
// equivocation evidence, long-poll waiters, limits and persistence.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateHash } from '../../sdk/src/index.mjs';
import { memoryBackend } from '../../sdk/src/store.mjs';
import { fileBackend } from '../../sdk/src/store-file.mjs';
import { Archive, KeeperError } from '../archive.mjs';
import { CHAIN, CHANNEL, Session, copy, counter, keys, played, prefix, resign, signed, terms } from './fixtures.mjs';

const open = (backend = memoryBackend(), options = {}) =>
  Archive.open(backend, { games: [[CHANNEL, counter]], chainId: CHAIN, ...options });
const ids = (game_id = 7n) => ({ chain_id: CHAIN, channel: CHANNEL, game_id });
const rejects = (promise, status, pattern) =>
  assert.rejects(promise, e => e instanceof KeeperError && e.status === status && pattern.test(e.message));

test('registration verifies every signature and the terms onchain', async () => {
  const checked = [];
  const archive = await open(memoryBackend(), { verify: async session => {
    checked.push(session.terms.game_id);
    if (session.terms.game_id === 9n) throw new KeeperError(409, 'The terms differ from the channel onchain');
  } });
  const session = played([3, 2]);
  assert.deepEqual(await archive.register(session.export()), { start: 0, seq: 2, transcript: session.env.transcript, created: true });
  await rejects(archive.register(played([1], new Session(counter, terms(9n))).export()), 409, /differ/);
  const forged = structuredClone(session.export());
  forged.steps[1].signature.s ^= 1n;
  await rejects(archive.register({ ...forged, terms: terms(8n) }), 400, /Invalid session signature/);
  await rejects(archive.register({ ...session.export(), terms: { ...terms(), channel: 0x5n } }), 404, /not kept here/);
  await rejects(archive.register({ ...session.export(), terms: { ...terms(), chain_id: 1n } }), 400, /chain/);
  await rejects(archive.register({ terms: {} }), 400, /Expected/);
  assert.deepEqual(checked, [7n, 9n]);
  assert.equal((await archive.session(ids())).stateHash(), session.stateHash());
});

test('appends extend the transcript, skip duplicates and keep a valid prefix', async () => {
  const archive = await open();
  const session = played([3]);
  await archive.register(session.export());
  played([2, 1], session);
  assert.equal((await archive.append(ids(), 0, signed(session))).accepted, 2);
  assert.equal((await archive.append(ids(), 1, signed(session, 1))).accepted, 0);
  const bad = signed(played([3, 1], copy(session)), 3);
  bad[1] = { ...bad[1], signature: { ...bad[1].signature, s: bad[1].signature.s ^ 1n } };
  await assert.rejects(archive.append(ids(), 3, bad), e => e.status === 400 && e.data.accepted === 1 && e.data.seq === 4);
  await rejects(archive.append(ids(), 9, []), 409, /between seq 0 and 4/);
  await rejects(archive.append(ids(8n), 0, []), 404, /Unknown game/);
  assert.deepEqual((await archive.steps(ids(), 3)).steps.map(r => r.seq), [3]);
});

test('the higher-ranked branch wins, and equivocation is recorded', async () => {
  const archive = await open();
  const shared = played([3]);
  const honest = played([2], copy(shared)); // seat 1 signs add(2) at seq 1
  await archive.register(honest.export());
  // Seat 1 also signs add(1) at seq 1, and seat 0 answers it: that branch ranks higher.
  const fork = played([1, 1], copy(shared));
  const switched = await archive.append(ids(), 1, signed(fork, 1));
  assert.deepEqual([switched.switched, switched.seq, switched.accepted], [1, 3, 2]);
  assert.equal((await archive.session(ids())).stateHash(), fork.stateHash());
  // The losing branch is refused but its signature still counts as evidence, once.
  await rejects(archive.append(ids(), 1, signed(honest, 1)), 409, /Conflicts with the archived step at seq 1/);
  const [evidence] = await archive.evidence(ids());
  assert.deepEqual([evidence.seq, evidence.seat, evidence.steps.length], [1, 1, 2]);
  assert.deepEqual(evidence.steps.map(s => s.message).sort(), [honest.steps[1].message, fork.steps[1].message].sort());
  // A resignation racing the other seat's move is a conflict, not equivocation.
  const racing = prefix(fork, 2);
  racing.move(resign(1), keys[1]);
  await assert.rejects(archive.append(ids(), 2, signed(racing, 2)), e => e.status === 409 && e.data.equivocation === false);
  assert.equal((await archive.evidence(ids())).length, 1);
});

test('a re-registered session merges, and only the chain anchor replaces a disjoint one', async () => {
  let anchor = 0n;
  const archive = await open(memoryBackend(), { anchorHash: async () => anchor });
  const session = played([3, 2]);
  await archive.register(session.export());
  // A client that rebased at seq 1 (a checkpoint) sends its later steps.
  played([1, 2], session);
  const later = { ...session.export(), start: prefix(session, 1).env, steps: signed(session, 1) };
  assert.equal((await archive.register(later)).accepted, 2);
  assert.equal((await archive.session(ids())).env.seq, 4);
  // An anchor the archive never saw (e.g. after forced play onchain).
  const elsewhere = played([1], copy(session));
  const after = { ...elsewhere.export(), start: elsewhere.env, steps: [] };
  await rejects(archive.register(after), 409, /neither overlaps/);
  anchor = stateHash(counter, elsewhere.env);
  assert.equal((await archive.register(after)).reanchored, true);
  assert.equal((await archive.session(ids())).start.seq, 5);
});

test('waiters wake on new steps, or time out', async () => {
  const archive = await open();
  const session = played([3]);
  await archive.register(session.export());
  const woken = archive.wait(ids(), 1, 5000);
  const early = archive.wait(ids(), 0, 5000);
  await early.promise; // already past seq 0
  played([2], session);
  await archive.append(ids(), 1, signed(session, 1));
  await woken.promise;
  const started = Date.now();
  await archive.wait(ids(), 2, 50).promise;
  assert.ok(Date.now() - started >= 45);
  const cancelled = archive.wait(ids(), 2, 60000);
  cancelled.cancel();
  await cancelled.promise;
});

test('limits on games and steps', async () => {
  const archive = await open(memoryBackend(), { maxGames: 1, maxSteps: 3 });
  const session = played([3, 2]);
  await archive.register(session.export());
  await rejects(archive.register(played([1], new Session(counter, terms(8n))).export()), 503, /full/);
  played([1, 3], session);
  await assert.rejects(archive.append(ids(), 2, signed(session, 2)), e => e.status === 400 && e.data.accepted === 1);
  await rejects(archive.register(played([1, 1, 1, 1], new Session(counter, terms(8n))).export()), 413, /limited to 3/);
});

test('the archive, its evidence and closed games survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'referee-keeper-'));
  try {
    let backend = await fileBackend(dir);
    let archive = await open(backend);
    const shared = played([3]);
    await archive.register(played([2], copy(shared)).export());
    await archive.append(ids(), 1, signed(played([1, 1], copy(shared)), 1));
    await archive.register(played([1], new Session(counter, terms(8n))).export());
    await archive.close(ids(8n), 4);
    await backend.close();

    backend = await fileBackend(dir);
    archive = await open(backend);
    assert.deepEqual(archive.open().map(i => i.game_id), [7n]);
    assert.equal((await archive.session(ids())).env.seq, 3);
    assert.equal((await archive.evidence(ids())).length, 1);
    await backend.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
