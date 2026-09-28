// The keeper's chain loop against a fake chain: which disputes it answers,
// when it resolves, how it settles, and what it leaves to the players.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stateHash } from '../../sdk/src/index.mjs';
import { memoryBackend } from '../../sdk/src/store.mjs';
import { Archive } from '../archive.mjs';
import { ACTIVE, CANCELLED, DISPUTE, FORCED, SETTLED, WAITING, decide, startWatcher } from '../watch.mjs';
import { CHAIN, CHANNEL, channelOf, counter, entry, fakeChain, played, prefix } from './fixtures.mjs';

const FINISHED = [3, 3, 3, 3, 3, 3, 2]; // reaches the target of 20 at seq 7

test('decide follows the channel rules', () => {
  const session = played([3, 2, 1]);
  const at = n => prefix(session, n).env;
  const dispute = (options, now = 1000) => decide(channelOf(session, { status: DISPUTE, deadline: 2000, ...options }), session, now);

  const answer = dispute({ candidate: at(1) });
  assert.deepEqual([answer.action, answer.base.start.seq, answer.base.env.seq], ['answer', 0, 3]);
  const fromCheckpoint = dispute({ anchor: at(2) });
  assert.deepEqual([fromCheckpoint.action, fromCheckpoint.base.start.seq, fromCheckpoint.base.steps.length], ['answer', 2, 1]);
  assert.deepEqual(dispute({ candidate: session.env }), { action: 'wait', reason: 'the candidate is current' });
  assert.deepEqual(dispute({ anchor: session.env }), { action: 'wait', reason: 'nothing past the anchor' });
  assert.deepEqual(dispute({ anchor: played([2], prefix(session, 2)).env }), { action: 'wait', reason: 'the channel anchor is not in the archive' });
  assert.deepEqual(dispute({ candidate: at(1) }, 2000), { action: 'resolve' });

  const finished = played(FINISHED);
  assert.equal(decide(channelOf(finished), finished, 0).action, 'settle');
  assert.equal(decide(channelOf(finished), finished, 0, { settle: false }).action, 'wait');
  assert.equal(decide(channelOf(session), session, 0).action, 'wait');
  for (const [status, action] of [[SETTLED, 'close'], [CANCELLED, 'close'], [WAITING, 'wait'], [FORCED, 'wait']])
    assert.equal(decide(channelOf(session, { status }), session, 0).action, action);
});

async function watching(chain, entryOptions) {
  const archive = await Archive.open(memoryBackend(), { games: [[CHANNEL, counter]], chainId: CHAIN });
  const logs = [];
  const watcher = startWatcher({ archive, chain, entries: new Map([[CHANNEL, entry(entryOptions)]]), intervalMs: 0, log: e => logs.push(e) });
  const round = async () => { await watcher.tick(); await watcher.idle(); };
  return { archive, logs, round };
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

test('a stale candidate is answered from the checkpoint the channel holds', async () => {
  const chain = fakeChain();
  const { archive, round } = await watching(chain);
  const game = played([3, 2, 1, 2]);
  await archive.register(game.export());
  const checkpoint = prefix(game, 1).env;
  chain.channels.set(7n, channelOf(game, { status: DISPUTE, epoch: 1, anchor: checkpoint, candidate: prefix(game, 2).env, deadline: 5000 }));
  await round();
  const [answer] = chain.sent;
  assert.deepEqual([answer.via, answer.epoch, answer.session.start.seq, answer.session.steps.length], ['history', 1, 1, 3]);
  assert.equal(stateHash(counter, answer.session.start), stateHash(counter, checkpoint));
});

test('long transcripts are proved; without a prover or an account the keeper only reports', async () => {
  const game = played(FINISHED);
  const run = async (chain, options) => {
    const { archive, logs, round } = await watching(chain, options);
    await archive.register(game.export());
    chain.channels.set(7n, channelOf(game));
    await round();
    return logs;
  };
  const proving = fakeChain();
  await run(proving, { max_history_steps: 4, prover: { url: 'http://prover', class_hash: 1n } });
  assert.deepEqual(proving.sent.map(s => [s.via, s.session.steps.length]), [['proof', 7]]);

  const unproved = fakeChain();
  const [failed] = await run(unproved, { max_history_steps: 4 });
  assert.deepEqual([failed.outcome, unproved.sent.length], ['failed', 0]);
  assert.match(failed.error, /exceed max_history_steps and no prover/);

  const watchOnly = fakeChain({ canSend: false });
  const [skipped] = await run(watchOnly);
  assert.deepEqual([skipped.action, skipped.outcome, watchOnly.sent.length], ['settle', 'skipped', 0]);
});

test('an unreadable channel is logged and the round goes on', async () => {
  const chain = fakeChain();
  const { archive, logs, round } = await watching(chain);
  const game = played(FINISHED);
  await archive.register(game.export());
  await round();
  assert.deepEqual([logs[0].action, logs[0].outcome, logs[0].error], ['read', 'failed', 'Unknown channel']);
  chain.channels.set(7n, channelOf(game, { status: ACTIVE }));
  await round();
  assert.equal(chain.sent.length, 1);
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
