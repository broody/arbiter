// The keeper's chain loop against a fake chain: which disputes it answers and
// acknowledges, when it resolves, how it settles, what it registers itself,
// and what it leaves to the players.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZERO_SIGNATURE, liveHash, publicKey, refereeResumeHash, signedStep, stateHash, verify } from '../../sdk/src/index.mjs';
import { openGameCall } from '../../sdk/src/proving.mjs';
import { memoryBackend } from '../../sdk/src/store.mjs';
import { Archive } from '../archive.mjs';
import { ACTIVE, DISPUTE, FORCED, SETTLED, UNOPENED, decide, startWatcher, unopened } from '../watch.mjs';
import {
  CHAIN, CHANNEL, REFEREE_KEY, Session, add, channelOf, counter, entry, fakeChain, keys, played, prefix, signed, terms, timed,
} from './fixtures.mjs';

const FINISHED = [3, 3, 3, 3, 3, 3, 2]; // reaches the target of 20 at seq 7
const ids = { chain_id: CHAIN, channel: CHANNEL, game_id: 7n };
const hash = env => stateHash(counter, env);

test('decide follows the channel rules', () => {
  const session = played([3, 2, 1]);
  const at = n => prefix(session, n).env;
  const dispute = (options, now = 1400, extra = {}) =>
    decide(channelOf(session, { status: DISPUTE, deadline: 2000, ...options }), session, now, extra);

  // An untimed dispute is answered from 600 s before its deadline, extending the candidate.
  assert.deepEqual(dispute({ candidate: at(1) }, 1399), { action: 'wait', reason: 'answering near the deadline' });
  const answer = dispute({ candidate: at(1) });
  assert.deepEqual([answer.action, answer.base.start.seq, answer.base.env.seq], ['answer', 1, 3]);
  // From the anchor when the candidate is on another branch, and cut to `maxSteps`.
  const elsewhere = played([1], prefix(session, 1)).env;
  const fromAnchor = dispute({ candidate: elsewhere });
  assert.deepEqual([fromAnchor.action, fromAnchor.base.start.seq, fromAnchor.base.env.seq], ['answer', 0, 3]);
  assert.equal(dispute({ candidate: at(1) }, 1400, { maxSteps: 1 }).base.env.seq, 2);
  // Nothing outranks the candidate, or the keeper answered it already, or it is the keeper's own.
  assert.equal(dispute({ candidate: session.env }).action, 'wait');
  assert.equal(dispute({ anchor: played([2], prefix(session, 2)).env }).action, 'wait');
  assert.deepEqual(dispute({ candidate: at(1) }, 1400, { sent: { against: new Set([hash(at(1))]) } }), { action: 'wait', reason: 'answered' });
  assert.equal(dispute({ candidate: at(1) }, 1400, { sent: { ours: new Set([hash(at(1))]) } }).action, 'wait');
  assert.deepEqual(dispute({ candidate: at(1) }, 2000), { action: 'resolve' });

  // The referee of a timed game acknowledges a dispute at once, once.
  const referee = { referee: true };
  assert.deepEqual(dispute({ candidate: at(1) }, 0, referee), { action: 'acknowledge' });
  assert.equal(dispute({ candidate: at(1) }, 0, { ...referee, sent: { ack: '0/2000' } }).action, 'wait');
  assert.equal(dispute({ candidate: at(1), acked_epoch: 0, acked_deadline: 2000 }, 0, referee).action, 'wait');
  assert.equal(dispute({ candidate: at(1), acked_epoch: 0, acked_deadline: 1000 }, 0, referee).action, 'acknowledge');
  // Near the deadline without the acknowledgement onchain, it answers first; with it, never.
  assert.equal(dispute({ candidate: at(1) }, 1400, referee).action, 'answer');
  assert.equal(dispute({ candidate: at(1) }, 1400, { ...referee, sent: { ack: '0/2000' } }).action, 'answer');
  assert.deepEqual(dispute({ candidate: at(1), acked_epoch: 0, acked_deadline: 2000 }, 1400, referee),
    { action: 'wait', reason: 'acknowledged' });
  // A finished candidate settles at resolve, acknowledged or not.
  const finished = played(FINISHED);
  assert.equal(decide(channelOf(finished, { status: DISPUTE, candidate: finished.env, deadline: 2000 }), finished, 0, referee).action,
    'wait');

  // A finished game settles at once, a segment at a time.
  assert.equal(decide(channelOf(finished), finished, 0).action, 'settle');
  assert.equal(decide(channelOf(finished), finished, 0, { settle: false }).action, 'wait');
  const segment = decide(channelOf(finished, { status: DISPUTE, candidate: prefix(finished, 3).env, deadline: 2000 }), finished, 0,
    { maxSteps: 3 });
  assert.deepEqual([segment.action, segment.base.start.seq, segment.base.env.seq], ['settle', 3, 6]);
  assert.equal(decide(channelOf(session), session, 0).action, 'wait');

  // The referee resumes forced play from an anchor the archive holds, within the forced-play window.
  const forced = options => channelOf(session, { status: FORCED, epoch: 1, anchor: at(2), deadline: 2000, ...options });
  assert.equal(decide(forced(), session, 0).action, 'wait');
  assert.deepEqual(decide(forced(), session, 0, referee), { action: 'resume' });
  assert.equal(decide(forced(), session, 2000, referee).action, 'wait');
  assert.equal(decide(forced({ anchor: elsewhere }), session, 0, referee).action, 'wait');
  assert.equal(decide(forced(), session, 0, { ...referee, sent: { resumed: 1 } }).action, 'wait');

  assert.equal(decide(channelOf(session, { status: SETTLED }), session, 0).action, 'close');
});

test('a game nobody opened yet is settled from its opening, or left alone', () => {
  const finished = played(FINISHED), unfinished = prefix(finished, 3);
  // What the watcher reads for it: epoch 0 at the terms' opening state.
  const channel = unopened(finished);
  assert.deepEqual([channel.status, channel.epoch, channel.anchor.seq], [UNOPENED, 0, 0]);
  assert.equal(channel.anchor.hash, stateHash(counter, finished.start));
  const settle = decide(channel, finished, 0);
  assert.deepEqual([settle.action, settle.base.start.seq, settle.base.env.seq], ['settle', 0, finished.env.seq]);
  assert.deepEqual(decide(unopened(unfinished), unfinished, 0), { action: 'wait', reason: 'not open' });
  assert.equal(decide(channel, finished, 0, { settle: false }).action, 'wait');
  // Submitted once: the next round waits for the channel to show it.
  assert.equal(decide(channel, finished, 0, { sent: { against: new Set([channel.candidate.hash]) } }).action, 'wait');
});

async function watching(chain, entryOptions, archiveOptions = {}, backend = memoryBackend()) {
  const archive = await Archive.open(backend, { games: [[CHANNEL, counter]], chainId: CHAIN, ...archiveOptions });
  const logs = [];
  const watcher = startWatcher({ archive, chain, entries: new Map([[CHANNEL, entry(entryOptions)]]), intervalMs: 0, log: e => logs.push(e) });
  const round = async () => { await watcher.tick(); await watcher.idle(); };
  return { archive, logs, round };
}
const refereeing = { referee: { privateKey: REFEREE_KEY } };

/** A timed game the archive referees, with `amounts` played and stamped. */
async function refereed(archive, amounts) {
  const session = new Session(counter, timed());
  await archive.register(session.export());
  for (const amount of amounts) {
    await archive.append(ids, session.env.seq, [signedStep(session.sign(add(amount), keys[session.due()]))]);
    session.receive(signedStep((await archive.steps(ids, session.env.seq)).steps[0]));
  }
  return archive.session(ids);
}

test('a finished game is settled, then resolved after its window, then closed', async () => {
  const chain = fakeChain();
  const { archive, logs, round } = await watching(chain);
  const game = played(FINISHED);
  await archive.register(game.export());
  chain.channels.set(7n, channelOf(game));
  await round();
  const [settled] = chain.sent;
  assert.deepEqual([settled.via, settled.epoch, settled.session.start.seq, settled.session.stateHash()], ['history', 0, 0, game.stateHash()]);
  // Unapproved, the result is a candidate: wait out the window, then resolve.
  chain.channels.set(7n, channelOf(game, { status: DISPUTE, candidate: game.env, deadline: 2000 }));
  await round();
  assert.equal(chain.sent.length, 1);
  chain.time = 2000;
  await round();
  assert.deepEqual(chain.sent[1], { via: 'resolve', gameId: 7n, epoch: 0 });
  chain.channels.set(7n, channelOf(game, { status: SETTLED, epoch: 1 }));
  await round();
  assert.deepEqual(archive.open(), []);
  assert.deepEqual(logs.map(l => [l.action, l.outcome ?? l.status]), [['settle', 'sent'], ['resolve', 'sent'], ['close', SETTLED]]);
});

test('an untimed dispute is answered once, near its deadline, from the candidate on', async () => {
  const chain = fakeChain();
  const { archive, round } = await watching(chain);
  const game = played([3, 2, 1, 2]);
  await archive.register(game.export());
  const checkpoint = prefix(game, 1).env, stale = prefix(game, 2).env;
  const dispute = candidate => channelOf(game, { status: DISPUTE, epoch: 1, anchor: checkpoint, candidate, deadline: 5000 });
  chain.channels.set(7n, dispute(stale));
  await round();
  assert.equal(chain.sent.length, 0);
  // 600 s before the deadline, it submits what extends the candidate.
  chain.time = 4400;
  await round();
  const [answer] = chain.sent;
  assert.deepEqual([answer.via, answer.epoch, answer.session.start.seq, answer.session.steps.length], ['history', 1, 2, 2]);
  assert.equal(hash(answer.session.start), hash(stale));
  // Never again each round: not while the channel shows the candidate it answered, nor once it shows its answer,
  // even as the game goes on offchain.
  await round();
  chain.channels.set(7n, dispute(game.env));
  played([1, 1], game);
  await archive.append(ids, 4, signed(game, 4));
  await round();
  assert.equal(chain.sent.length, 1);
  // A seat submits a newer candidate: the keeper outranks it, once.
  chain.channels.set(7n, dispute(prefix(game, 5).env));
  await round();
  await round();
  assert.deepEqual(chain.sent.map(s => [s.session.start.seq, s.session.env.seq]), [[2, 4], [5, 6]]);
});

test('long transcripts settle in segments; without an account the keeper only reports', async () => {
  const game = played(FINISHED);
  const run = async (chain, options) => {
    const { archive, logs, round } = await watching(chain, options);
    await archive.register(game.export());
    chain.channels.set(7n, channelOf(game));
    await round();
    return logs;
  };
  const proving = fakeChain();
  await run(proving, { replay_max_steps: 4, prover: { url: 'http://prover', class_hash: 1n } });
  assert.deepEqual(proving.sent.map(s => [s.via, s.session.steps.length]), [['proof', 7]]);

  // Without a prover, a replay's worth at a time.
  const replaying = fakeChain();
  await run(replaying, { replay_max_steps: 4 });
  assert.deepEqual(replaying.sent.map(s => [s.via, s.session.start.seq, s.session.steps.length]), [['history', 0, 4]]);

  const watchOnly = fakeChain({ canSend: false });
  const [skipped] = await run(watchOnly);
  assert.deepEqual([skipped.action, skipped.outcome, watchOnly.sent.length], ['settle', 'skipped', 0]);
});

test('a long finished game settles as chained segments within one dispute, each by replay or proof', async () => {
  const chain = fakeChain();
  const { archive, logs, round } = await watching(chain, { replay_max_steps: 2, proof_max_steps: 3,
    prover: { url: 'http://prover', class_hash: 1n } });
  const game = played(FINISHED);
  await archive.register(game.export());
  // The first segment opens a dispute; each next one extends the candidate.
  chain.channels.set(7n, channelOf(game));
  await round();
  for (const seq of [3, 6, 7]) {
    chain.channels.set(7n, channelOf(game, { status: DISPUTE, candidate: prefix(game, seq).env, deadline: 5000 }));
    await round();
  }
  // The finished candidate settles at resolve.
  chain.time = 5000;
  await round();
  assert.deepEqual(chain.sent.map(s => [s.via, s.epoch, s.session?.start.seq, s.session?.steps.length]),
    [['proof', 0, 0, 3], ['proof', 0, 3, 3], ['history', 0, 6, 1], ['resolve', 0, undefined, undefined]]);
  assert.equal(hash(chain.sent[2].session.env), game.stateHash());
  assert.deepEqual(logs.map(l => l.action), ['settle', 'settle', 'settle', 'resolve']);
});

test('the referee acknowledges a dispute at once, once, and lets resolve return the game to play', async () => {
  const chain = fakeChain();
  const { archive, round } = await watching(chain, {}, refereeing);
  try {
    const session = await refereed(archive, [3, 2]);
    const dispute = options => channelOf(session, { status: DISPUTE, epoch: 0, candidate: prefix(session, 1).env, deadline: 5000, ...options });
    chain.channels.set(7n, dispute());
    await round();
    const [ack] = chain.sent;
    assert.deepEqual([ack.via, ack.gameId, ack.epoch], ['acknowledge', 7n, 0]);
    assert.ok(verify(liveHash(counter, session.context, 0, 5000), ack.signature, publicKey(REFEREE_KEY)));
    // Sent: not again, even before the channel shows it.
    await round();
    chain.channels.set(7n, dispute({ acked_epoch: 0, acked_deadline: 5000 }));
    await round();
    // Acknowledged: no submission, even near the deadline.
    chain.time = 4900;
    await round();
    assert.equal(chain.sent.length, 1);
    chain.time = 5000;
    await round();
    assert.deepEqual(chain.sent.map(s => s.via), ['acknowledge', 'resolve']);
  } finally { archive.stop(); }
});

test('without its acknowledgement onchain near the deadline, the referee submits the latest attested state, once', async () => {
  const chain = fakeChain();
  chain.failing.add('acknowledge');
  const { archive, logs, round } = await watching(chain, {}, refereeing);
  try {
    const session = await refereed(archive, [3, 2, 1]);
    chain.channels.set(7n, channelOf(session, { status: DISPUTE, deadline: 5000 }));
    await round();
    assert.deepEqual(logs.map(l => [l.action, l.outcome]), [['acknowledge', 'failed']]);
    chain.time = 4400;
    await round();
    const [answer] = chain.sent;
    assert.deepEqual([answer.via, answer.epoch, answer.session.start.seq, answer.session.stateHash()],
      ['history', 0, 0, session.stateHash()]);
    assert.equal(answer.session.steps.at(-1).stamp, session.steps.at(-1).stamp);
    // Not again: the acknowledgement is retried, the submission isn't.
    await round();
    chain.channels.set(7n, channelOf(session, { status: DISPUTE, candidate: session.env, deadline: 5000 }));
    await round();
    assert.equal(chain.sent.length, 1);
    assert.deepEqual(logs.map(l => l.action), ['acknowledge', 'answer', 'acknowledge', 'acknowledge']);
  } finally { archive.stop(); }
});

test('the referee returns a game from forced play, and the clock restarts without charging it', async () => {
  const chain = fakeChain();
  const { archive, round } = await watching(chain, {}, refereeing);
  try {
    const session = await refereed(archive, [3]);
    // An unacknowledged dispute ended in forced play at epoch 1, from the latest state.
    const forced = options => channelOf(session, { status: FORCED, epoch: 1, anchor: session.env, deadline: 9000, ...options });
    chain.channels.set(7n, forced());
    await round();
    const [resume] = chain.sent;
    assert.deepEqual([resume.via, resume.gameId, resume.epoch], ['resume', 7n, 1]);
    assert.ok(verify(refereeResumeHash(counter, session.context, 1, session.stateHash()), resume.signature, publicKey(REFEREE_KEY)));
    // A stale read of the channel sends nothing more.
    await round();
    assert.equal(chain.sent.length, 1);
    chain.channels.set(7n, channelOf(session, { status: ACTIVE, epoch: 2, anchor: session.env }));
    await round();
    // Bob's step comes before the start grace ends: stamped at the last stamp, so forced play cost him nothing.
    const bob = new Session(counter, timed());
    bob.receive(signedStep(session.steps[0]));
    await archive.append(ids, 1, [signedStep(bob.sign(add(2), keys[1]))]);
    const steps = (await archive.session(ids)).steps;
    assert.equal(steps[1].stamp, steps[0].stamp);
    assert.equal(chain.sent.length, 1);
  } finally { archive.stop(); }
});

test('the referee leaves forced play alone from an anchor it lacks', async () => {
  const chain = fakeChain();
  const { archive, round } = await watching(chain, {}, refereeing);
  try {
    const session = await refereed(archive, [3]);
    // Forced steps onchain moved the anchor to a state the archive never saw.
    chain.channels.set(7n, channelOf(session, { status: FORCED, epoch: 1, anchor: played([1]).env, deadline: 9000 }));
    await round();
    assert.equal(chain.sent.length, 0);
  } finally { archive.stop(); }
});

test('the referee registers the timed games that open naming its key, from the world\'s events', async () => {
  const chain = fakeChain();
  const { archive, logs, round } = await watching(chain, { world: 0x3031dn, namespace: 'counter' }, refereeing);
  try {
    chain.termsOf.set(7n, timed(7n));
    chain.termsOf.set(8n, terms(8n));
    chain.termsOf.set(9n, { ...timed(9n), clock: { ...timed(9n).clock, referee: publicKey(0x999n) } });
    chain.channels.set(7n, channelOf(new Session(counter, timed(7n))));
    chain.openings.push({ game_id: 5n, block: 9 }, { game_id: 7n, block: 12 }, { game_id: 8n, block: 12 }, { game_id: 9n, block: 13 });
    // The first round starts from the chain's head: game 5 joined before the keeper ran.
    await round();
    assert.deepEqual(archive.open(), []);
    chain.block = 13;
    await round();
    // Only the timed game that names its key: untimed game 8 and game 9, refereed by another key, stay out.
    assert.deepEqual(archive.open().map(i => i.game_id), [7n]);
    assert.ok(archive.referees(ids));
    assert.equal((await archive.session(ids)).env.seq, 0);
    assert.deepEqual(logs.filter(l => l.action === 'register'), [{ game: '0xc4a11e1/0x7', action: 'register', outcome: 'opened' }]);
    // Each join is read once.
    await round();
    assert.equal(chain.reads.terms, 3);
  } finally { archive.stop(); }
});

test('the referee retries an opened game it failed to register each round, across restarts, unless the archive refused it', async () => {
  const chain = fakeChain();
  const world = { world: 0x3031dn, namespace: 'counter' }, options = { ...refereeing, maxOpenGames: 1 };
  const first = await watching(chain, world, options);
  let again;
  const registers = logs => logs.filter(l => l.action === 'register').map(l => [l.game, l.outcome, l.error]);
  try {
    for (const id of [7n, 8n, 9n]) {
      chain.termsOf.set(id, timed(id));
      chain.channels.set(id, channelOf(new Session(counter, timed(id))));
    }
    // Game 9 closed here before its join was read.
    await first.archive.close(first.archive.ids(CHANNEL, 9n), SETTLED);
    chain.openings.push({ game_id: 7n, block: 10 }, { game_id: 9n, block: 10 });
    // The node can't read the terms: both joins are kept to retry.
    chain.failing.add('terms');
    await first.round();
    assert.deepEqual(registers(first.logs), [['0xc4a11e1/0x7', 'failed', 'terms failed'], ['0xc4a11e1/0x9', 'failed', 'terms failed']]);
    // After a restart, with no new block: game 7 registers, and the archive refuses game 9 for good.
    chain.failing.delete('terms');
    again = await watching(chain, world, options, first.archive.backend);
    await again.round();
    assert.deepEqual(again.archive.open().map(i => i.game_id), [7n]);
    await again.round();
    assert.equal(chain.reads.terms, 4);
    // A join while the keeper is full waits for a free slot.
    chain.openings.push({ game_id: 8n, block: 11 });
    chain.block = 11;
    await again.round();
    await again.round();
    await again.archive.close(ids, SETTLED);
    await again.round();
    await again.round();
    assert.deepEqual(again.archive.open().map(i => i.game_id), [8n]);
    assert.equal(chain.reads.terms, 7);
    const full = ['0xc4a11e1/0x8', 'failed', 'The keeper is full'];
    assert.deepEqual(registers(again.logs), [['0xc4a11e1/0x7', 'opened', undefined], ['0xc4a11e1/0x9', 'refused', 'The game is closed here'],
      full, full, ['0xc4a11e1/0x8', 'opened', undefined]]);
  } finally {
    first.archive.stop();
    again?.archive.stop();
  }
});

test('the resolve that settles a game carries its after-settle calls, or is followed by them', async () => {
  const rate = { contractAddress: '0xabc', entrypoint: 'rate', calldata: ['0x7'] };
  const hooked = [];
  const afterSettle = async (gameIds, channel) => {
    hooked.push([gameIds.game_id, channel.candidate.outcome.winner]);
    return [rate];
  };
  const game = played(FINISHED);
  const resolving = async (bundles, candidate = game.env) => {
    const chain = fakeChain();
    chain.bundles = bundles;
    const { archive, logs, round } = await watching(chain, { afterSettle });
    await archive.register(game.export());
    chain.channels.set(7n, channelOf(game, { status: DISPUTE, candidate, deadline: 2000 }));
    chain.time = 2000;
    await round();
    return { sent: chain.sent, log: logs.find(l => l.action === 'resolve') };
  };
  // When the bundle simulates, one transaction.
  const bundled = await resolving(true);
  assert.deepEqual(bundled.sent, [{ via: 'resolve', gameId: 7n, epoch: 0, after: [rate] }]);
  assert.deepEqual([bundled.log.bundled, bundled.log.after], [true, 1]);
  // Otherwise, the resolve and then the calls.
  const separate = await resolving(false);
  assert.deepEqual(separate.sent, [{ via: 'resolve', gameId: 7n, epoch: 0 }, { via: 'calls', calls: [rate] }]);
  assert.deepEqual([separate.log.bundled, separate.log.after_tx], [false, '0x6']);
  // A resolve that doesn't settle the game carries none.
  const unfinished = await resolving(true, prefix(game, 3).env);
  assert.deepEqual(unfinished.sent, [{ via: 'resolve', gameId: 7n, epoch: 0 }]);
  assert.deepEqual(hooked, [[7n, 1], [7n, 1]]);
});

test('an unreadable channel is logged and the round goes on', async () => {
  const chain = fakeChain();
  const { archive, logs, round } = await watching(chain);
  const game = played(FINISHED);
  await archive.register(game.export());
  chain.channels.set(7n, channelOf(game, { status: ACTIVE }));
  chain.failing.add('channel');
  await round();
  assert.deepEqual([logs[0].action, logs[0].outcome, logs[0].error], ['read', 'failed', 'channel failed']);
  chain.failing.delete('channel');
  await round();
  assert.equal(chain.sent.length, 1);
});

test('a finished game nobody opened opens in the transaction that settles it', async () => {
  const chain = fakeChain();
  const { archive, logs, round } = await watching(chain);
  const game = played(FINISHED);
  // Registered on its wallets' signatures, which the archive keeps.
  const authorizations = [[1n, 2n], [3n, 4n]];
  await archive.register(game.export(), authorizations);
  await round();
  assert.equal(chain.sent.length, 1);
  const [{ via, session, epoch, open }] = chain.sent;
  assert.deepEqual([via, epoch, session.start.seq, session.env.seq], ['history', 0, 0, game.env.seq]);
  assert.deepEqual(open, openGameCall(counter, game.terms, authorizations));
  assert.deepEqual([logs[0].action, logs[0].outcome], ['settle', 'sent']);
  // Not again while the chain catches up; once opened, the dispute runs as usual.
  await round();
  assert.equal(chain.sent.length, 1);
  chain.channels.set(7n, channelOf(game, { status: DISPUTE, epoch: 0, candidate: game.env, deadline: 900 }));
  await round();
  assert.deepEqual(chain.sent.map(s => s.via), ['history', 'resolve']);
});

test('a game module\'s openCall opens the game from what it registered with', async () => {
  const chain = fakeChain();
  const seen = [];
  const openCall = async (ids, terms, options) => { seen.push([ids.game_id, options]); return { entrypoint: 'open_rated', calldata: [7] }; };
  const { archive, round } = await watching(chain, { openCall });
  const game = played(FINISHED);
  await archive.register(game.export(), [[1n, 2n], [3n, 4n]], { ticket: '0x7', signature: ['0x1', '0x2'] });
  assert.deepEqual(await archive.extras(archive.ids(CHANNEL, 7n)), { ticket: '0x7', signature: ['0x1', '0x2'] });
  await round();
  assert.deepEqual(chain.sent[0].open, { entrypoint: 'open_rated', calldata: [7] });
  assert.deepEqual(seen, [[7n, { signatures: [[1n, 2n], [3n, 4n]], approvals: [[1n, 2n], [3n, 4n]],
    refereeSignature: ZERO_SIGNATURE, extras: { ticket: '0x7', signature: ['0x1', '0x2'] } }]]);
});

test('a game nobody opened, unfinished, is left alone', async () => {
  const chain = fakeChain();
  const { archive, round } = await watching(chain);
  await archive.register(prefix(played(FINISHED), 3).export(), [[1n, 2n], [3n, 4n]]);
  await round();
  assert.equal(chain.sent.length, 0);
});

test('a game nobody opened without its wallets\' signatures cannot be opened', async () => {
  const chain = fakeChain();
  const { archive, logs, round } = await watching(chain);
  await archive.register(played(FINISHED).export());
  await round();
  assert.equal(chain.sent.length, 0);
  assert.deepEqual([logs[0].action, logs[0].outcome, logs[0].error], ['settle', 'failed', 'No wallet signatures to open the game with']);
});

test('an unanchored game is never looked up onchain', async () => {
  const chain = fakeChain();
  let reads = 0;
  chain.channel = async () => { reads += 1; throw Error('No channel'); };
  const { archive, logs, round } = await watching(chain, { anchored: false });
  await archive.register(played(FINISHED).export());
  await round();
  assert.equal(reads, 0);
  assert.deepEqual([chain.sent, logs], [[], []]);
});

test('a game a seat agreed to with a delegated key opens through open_game_delegable', async () => {
  const chain = fakeChain();
  const { archive, round } = await watching(chain);
  const delegated = { key: 5n, expires_at: 2000n, delegation: [6n, 7n], signature: { r: 8n, s: 9n } };
  await archive.register(played(FINISHED).export(), [delegated, [3n, 4n]]);
  await round();
  const { entrypoint, calldata } = chain.sent[0].open;
  assert.equal(entrypoint, 'open_game_delegable');
  // Each seat's approval, the delegated one tagged 1 and the wallet's 0, then no referee signature.
  assert.deepEqual(calldata.slice(-15).map(BigInt), [2n, 1n, 5n, 2000n, 2n, 6n, 7n, 8n, 9n, 0n, 2n, 3n, 4n, 0n, 0n]);
});
