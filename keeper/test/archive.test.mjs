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
import { CHAIN, CHANNEL, Session, add, copy, counter, keys, played, prefix, resign, signed, terms } from './fixtures.mjs';

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

test('a game must fit its entry\'s step cap, which bounds its transcript', async () => {
  // The counter to 20 can run to maxSteps + 1 = 97 steps.
  const tight = await open(memoryBackend(), { games: [[CHANNEL, { game: counter, maxSteps: 96 }]] });
  await rejects(tight.register(played([3]).export()), 409, /can run to 97 steps; this keeper keeps at most 96/);
  const archive = await open(memoryBackend(), { games: [[CHANNEL, { game: counter, maxSteps: 97 }]] });
  assert.equal((await archive.register(played([3]).export())).created, true);

  // A cap lowered after a game was admitted refuses its later steps.
  const backend = memoryBackend();
  await (await open(backend)).register(played([3, 2]).export());
  const lowered = await open(backend, { games: [[CHANNEL, { game: counter, maxSteps: 3 }]] });
  const session = played([3, 2, 1, 3]);
  await assert.rejects(lowered.append(ids(), 2, signed(session, 2)), e => e.status === 400 && e.data.accepted === 1);
  await rejects(lowered.register(played([1, 1, 1, 1], new Session(counter, terms(8n))).export()), 413, /limited to 3/);
});

test('only open games count against capacity, and closed ones stay readable', async () => {
  const archive = await open(memoryBackend(), { maxOpenGames: 1 });
  const session = played([3, 2]);
  await archive.register(session.export());
  await rejects(archive.register(played([1], new Session(counter, terms(8n))).export()), 503, /full/);
  assert.deepEqual(archive.capacity(), { open: 1, max_open_games: 1, reserved_games: 0, free: 0, free_unreserved: 0 });
  // The channel settles game 7: it leaves memory, and its slot is free.
  await archive.close(ids(), 4);
  assert.deepEqual([archive.open(), archive.known.size], [[], 0]);
  assert.equal((await archive.register(played([1], new Session(counter, terms(8n))).export())).created, true);
  assert.equal((await archive.session(ids())).stateHash(), session.stateHash());
  assert.equal((await archive.steps(ids(), 1)).steps.length, 1);
  // Registering it again can't reopen it.
  await rejects(archive.register(session.export()), 409, /closed/);
  await rejects(archive.append(ids(), 2, []), 409, /closed/);
});

test('reserved capacity goes to the games `admit` ranks above 0', async () => {
  const asked = [];
  const admit = async (gameIds, gameTerms) => {
    asked.push(gameIds.game_id);
    return gameTerms.game_id === 9n ? 1 : 0;
  };
  const archive = await open(memoryBackend(), { maxOpenGames: 3, reservedGames: 1, games: [[CHANNEL, { game: counter, admit }]] });
  const game = id => played([1], new Session(counter, terms(id))).export();
  await archive.register(game(5n));
  await archive.register(game(6n));
  // One slot left, and it is reserved.
  assert.deepEqual([archive.capacity().free, archive.capacity().free_unreserved], [1, 0]);
  await rejects(archive.register(game(8n)), 503, /reserved capacity is for priority games/);
  assert.equal((await archive.register(game(9n))).created, true);
  await rejects(archive.register(game(10n)), 503, /^The keeper is full$/);
  // `admit` is asked only near full.
  assert.deepEqual(asked, [8n, 9n]);
});

test('unanchored games: capped per wallet, closed once finished or idle', async () => {
  let now = 1_000_000;
  const CASUAL = 0n, alice = 0xa11cen;
  const archive = await open(memoryBackend(), { maxOpenPerPlayer: 2, unanchoredTtlMs: 60_000, now: () => now,
    games: [[CHANNEL, counter], [CASUAL, { game: counter, anchored: false }]] });
  const casual = (id, other = 0xca701n) => new Session(counter, { ...terms(id), channel: CASUAL, players: [alice, other] });
  const casualIds = id => ({ chain_id: CHAIN, channel: CASUAL, game_id: id });
  await archive.register(casual(1n).export());
  await archive.register(casual(2n, 0xda7en).export());
  // Alice plays two open unanchored games: a third is refused, whoever she plays.
  await rejects(archive.register(casual(3n, 0xe7en).export()), 429, /Wallet 0xa11ce already plays 2 open games/);
  // An anchored game is never refused for her caps.
  assert.equal((await archive.register(played([3]).export())).created, true);

  // Game 1 finishes: it closes at once, which frees her slot.
  const finished = played([3, 3, 3, 3, 3, 3, 2], casual(1n));
  await archive.append(casualIds(1n), 0, signed(finished));
  assert.equal(archive.known.has('0x0/0x1'), false);
  assert.equal((await archive.session(casualIds(1n))).env.outcome.finished, true);
  await archive.register(casual(3n, 0xe7en).export());

  // Game 2 idles past its time to live: the next registration that needs its slot sweeps it.
  now += 30_000;
  const active = casual(3n, 0xe7en);
  active.move(add(1), keys[0]);
  await archive.append(casualIds(3n), 0, signed(active));
  now += 31_000;
  await archive.register(casual(4n, 0xf00n).export());
  assert.deepEqual(archive.open().map(i => i.game_id).sort(), [3n, 4n, 7n]);
  assert.equal(await archive.sweep(), 0);
  now += 61_000;
  assert.equal(await archive.sweep(), 2);
  assert.deepEqual(archive.open().map(i => i.game_id), [7n]);
});

test('the archive, its evidence and closed games survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-keeper-'));
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
