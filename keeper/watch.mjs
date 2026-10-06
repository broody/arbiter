// The keeper's chain loop. Each round, it registers the timed games that
// opened onchain naming its referee key, then reads the channel of every open
// game and:
// - settles a finished game that is still active, in chained segments when its
//   transcript is long (see `disputeAnswer`). A game no channel has opened yet
//   opens in the same transaction, on its seats' wallet signatures;
// - as the referee of a timed game, acknowledges a dispute at once, so that
//   the game returns to play after the window instead of forced play, and
//   returns a game from forced play itself, first reading back from the chain
//   any forced play it did not see (e.g. while it was down);
// - answers any other dispute once, near its deadline, from the latest state:
//   the fallback, too, when a referee's acknowledgement has not landed;
// - resolves a dispute once its window has passed (anyone may), with the
//   game's after-settle calls when that settles it.
// It submits a segment by onchain replay (`submit_history`) when short, or by
// a native proof through the game's adapter. Forced play and timeouts
// otherwise need a player's wallet, so the keeper waits them out.
import {
  Session, ZERO_SIGNATURE, disputeAnswer, due, felt, hex, isDelegated, open, rebase, stateHash,
} from '../sdk/src/index.mjs';
import { openGameCall, openGameDelegableCall } from '../sdk/src/proving.mjs';
import { KeeperError, gameKey } from './archive.mjs';

/** Channel statuses (arbiter::channel). A game id no channel has opened reads as UNOPENED. */
export const UNOPENED = 0, ACTIVE = 1, DISPUTE = 2, FORCED = 3, SETTLED = 4;
const CURSOR = 'keeper/cursor/', RETRY = 'keeper/retry/';

const replayMax = entry => entry.replay_max_steps ?? entry.max_history_steps ?? 64;
/** Steps per submission: up to `proof_max_steps` with a prover, else `replay_max_steps`. */
export const segmentSteps = entry => Math.max(replayMax(entry), entry.prover ? entry.proof_max_steps ?? Infinity : 0);

/**
 * What to do about one game: `{ action, reason?, base? }`, where `action` is
 * close, wait, resolve, acknowledge, resume, settle or answer. `base` is the
 * session to submit, for settle and answer. Options:
 * - `settle`: submit finished games (default true);
 * - `referee`: this keeper referees the (timed) game;
 * - `margin`: seconds before a dispute's deadline from which to answer it;
 * - `maxSteps`: steps per submission;
 * - `sent`: what the keeper already sent in the channel's epoch, `{ against,
 *   ours, ack, resumed }`: the candidates it submitted against, the states
 *   it submitted, the `epoch/deadline` it acknowledged and the epoch it resumed;
 * - `answer(channel)`: the submission against the channel (default
 *   `disputeAnswer`); `holds(hash)`: whether the archive's history reaches
 *   that state (default `rebase`).
 */
export function decide(channel, session, now, { settle = true, referee = false, margin = 600, maxSteps = Infinity, sent = {},
  answer = c => disputeAnswer(session, c, { maxSteps }), holds = hash => rebase(session, hash) !== null } = {}) {
  const wait = reason => (reason ? { action: 'wait', reason } : { action: 'wait' });
  switch (channel.status) {
    case SETTLED: return { action: 'close' };
    case FORCED:
      if (!referee) return wait(`forced play: seat ${channel.anchor.due} is due`);
      if (sent.resumed === channel.epoch) return wait('resumed');
      if (now >= channel.deadline) return wait('the forced-play window has passed');
      return holds(channel.anchor.hash) ? { action: 'resume' } : wait('the channel anchor is not in the archive');
  }
  if (channel.status === DISPUTE && now >= channel.deadline) return { action: 'resolve' };
  const settling = settle && session.env.outcome.finished, candidate = felt(channel.candidate.hash);
  const answered = sent.against?.has(candidate) ?? false;
  const submit = action => {
    const base = answer(channel);
    return base ? { action, base } : null;
  };
  if (channel.status === ACTIVE || channel.status === UNOPENED) {
    if (!settling) return wait(channel.status === UNOPENED ? 'not open' : undefined);
    return answered ? wait('submitted') : submit('settle') ?? wait('nothing past the anchor');
  }
  // A dispute, window open. The referee's acknowledgement returns an
  // unfinished game to play after the window. An unfinished game is otherwise
  // answered once, near the deadline, and again only against a candidate
  // someone else submitted. Near the deadline, a submission goes first.
  const late = now >= channel.deadline - margin, ours = sent.ours?.has(candidate) ?? false;
  const acked = channel.acked_epoch === channel.epoch && channel.acked_deadline === channel.deadline;
  const ack = referee && !acked && !channel.candidate.outcome.finished && sent.ack !== `${channel.epoch}/${channel.deadline}`;
  const fallback = !settling && !answered && !ours && late && !(referee && acked);
  if ((settling && !answered && (late || !ack)) || fallback) {
    const decision = submit(settling ? 'settle' : 'answer');
    if (decision) return decision;
  }
  if (ack) return { action: 'acknowledge' };
  if (answered) return wait('answered');
  if (referee && acked) return wait('acknowledged');
  return wait(late ? 'the candidate is current' : 'answering near the deadline');
}

/**
 * What the watcher reads for a game no channel has opened yet: epoch 0, with
 * its terms' opening state as anchor and candidate, so the game's whole
 * transcript is what it would submit.
 */
export function unopened(session) {
  const { game, terms } = session, opening = open(game, terms);
  const ref = { hash: stateHash(game, opening), seq: 0, support_turn: 0, due: due(game, opening), outcome: opening.outcome };
  return { id: terms.game_id, status: UNOPENED, epoch: 0, context: session.context, anchor: ref, candidate: ref,
    anchor_block: 0, candidate_block: 0, deadline: 0, acked_epoch: 0, acked_deadline: 0, started: 0 };
}

/**
 * Watch the archive's open games against `chain` (see keeper/chain.mjs).
 * `entries` maps channel addresses (BigInt) to game entries. Returns
 * { tick, idle, stop }: `tick()` runs one round, `idle()` waits for actions in
 * flight.
 */
export function startWatcher({ archive, chain, entries, intervalMs = 15000, settle = true, log = () => {} }) {
  const busy = new Map(); // key -> action promise
  const memos = new Map(); // key -> what was sent in the channel's current epoch
  const anchors = new Map(); // key -> whether the archive holds a state, so forced rounds don't replay every transcript
  let timer = null, stopped = false;

  const sentIn = (key, epoch) => {
    let sent = memos.get(key);
    if (sent?.epoch !== epoch)
      memos.set(key, sent = { epoch, against: new Set(), ours: new Set(), ack: null, resumed: null, followed: null });
    return sent;
  };
  const holds = (key, session) => hash => {
    const cached = anchors.get(key);
    if (cached?.hash === hash && cached.session === session && cached.seq === session.env.seq) return cached.held;
    const held = rebase(session, hash) !== null;
    anchors.set(key, { hash, session, seq: session.env.seq, held });
    return held;
  };

  async function act(entry, ids, channel, { action, base }, sent) {
    switch (action) {
      case 'resolve': {
        // The game's own calls after it settles go with the resolve that settles it.
        let after = [];
        if (channel.candidate.outcome.finished && entry.afterSettle) {
          try { after = (await entry.afterSettle(ids, channel)) ?? []; } catch (e) {
            log({ game: gameKey(ids), action: 'after_settle', outcome: 'failed', error: e.message });
          }
        }
        return { ...await chain.resolve(entry, ids.game_id, channel.epoch, { after }), ...(after.length ? { after: after.length } : {}) };
      }
      case 'acknowledge': {
        const signature = archive.acknowledgement(ids, channel.epoch, channel.deadline);
        const tx = await chain.acknowledge(entry, ids.game_id, channel.epoch, signature);
        sent.ack = `${channel.epoch}/${channel.deadline}`;
        return { tx };
      }
      case 'resume': {
        const signature = archive.resumeSignature(ids, channel.epoch, channel.anchor.hash);
        const tx = await chain.resumeByReferee(entry, ids.game_id, channel.epoch, signature);
        sent.resumed = channel.epoch;
        await archive.resumed(ids, channel.epoch + 1);
        return { tx };
      }
    }
    // A game no channel holds yet opens in the same transaction.
    const opening = channel.status === UNOPENED ? { open: await openCall(entry, ids, base.terms) } : {};
    const via = base.steps.length <= replayMax(entry) ? 'history' : 'proof';
    const tx = via === 'history' ? await chain.submitHistory(entry, base, channel.epoch, opening)
      : await chain.settle(entry, base, channel.epoch, opening);
    sent.against.add(felt(channel.candidate.hash));
    sent.ours.add(felt(base.stateHash()));
    return { tx, via, from: base.start.seq, steps: base.steps.length };
  }

  // A game's `open_game` call, from the seats' approvals it was registered
  // with (`open_game_delegable` when any is delegated) and, when it takes its
  // randomness from this keeper's referee, the referee's signature over its
  // tip. A game module's `openCall` builds it instead when it has one, with
  // what the game registered with (`extras`).
  async function openCall(entry, ids, terms) {
    const authorizations = await archive.authorizations(ids);
    if (!authorizations) throw Error('No wallet signatures to open the game with');
    let refereeSignature = ZERO_SIGNATURE;
    const tip = terms.clock?.rng_tip ?? 0n;
    if (felt(tip) !== 0n) {
      if (archive.referee === null || felt(terms.clock.referee) !== archive.referee)
        throw Error('The game takes another referee\'s randomness: a seat opens it');
      const signed = await archive.tip(ids, terms.config);
      if (felt(tip) !== signed.rng_tip) throw Error('The game\'s randomness tip is not this referee\'s');
      refereeSignature = signed.signature;
    }
    const delegated = authorizations.some(isDelegated);
    const signatures = delegated ? null : authorizations.map(a => (Array.isArray(a) ? a : [a.r, a.s]));
    if (entry.openCall) {
      return entry.openCall(ids, terms,
        { signatures, approvals: authorizations, refereeSignature, extras: await archive.extras(ids) });
    }
    if (delegated) {
      return openGameDelegableCall(entry.game, terms, authorizations,
        { refereeSignature, entrypoint: entry.entrypoints.open_game_delegable });
    }
    return openGameCall(entry.game, terms, signatures, { refereeSignature, entrypoint: entry.entrypoints.open_game });
  }

  async function visit(ids, now) {
    const key = gameKey(ids), entry = entries.get(ids.channel);
    // An unanchored game has no channel to watch.
    if (!entry || entry.anchored === false) return;
    let session = await archive.session(ids);
    if (!session) return;
    const onchain = await chain.channel(entry, ids.game_id);
    // Once a channel holds the game, its wallets' caps no longer count it.
    if (onchain !== null) await archive.opened(ids);
    const channel = onchain ?? unopened(session);
    // The referee's clock stops for forced play, and restarts after it.
    if (archive.referees(ids)) {
      if (channel.status === FORCED) await archive.forced(ids, channel.epoch);
      else if (channel.status === ACTIVE || channel.status === DISPUTE) await archive.resumed(ids, channel.epoch);
    }
    const sent = sentIn(key, channel.epoch);
    // Forced play the keeper did not see, as when it was down: read its calls
    // back from the chain, once per anchor, so the referee can take the game
    // back from there (and answer a roll a seat asked for onchain).
    if (channel.status === FORCED && archive.referees(ids) && chain.forcedPlay && entry.world
      && sent.followed !== channel.anchor.hash && !holds(key, session)(channel.anchor.hash)) {
      sent.followed = channel.anchor.hash;
      const entryLog = { game: key, action: 'follow', epoch: channel.epoch };
      try {
        const calls = await chain.forcedPlay(entry, ids.game_id, holds(key, session));
        if (calls?.length && await archive.follow(ids, calls)) {
          session = await archive.session(ids);
          log({ ...entryLog, calls: calls.length, seq: session.env.seq, outcome: 'followed' });
        } else log({ ...entryLog, outcome: 'skipped', error: 'the chain does not show how forced play reached the anchor' });
      } catch (e) { log({ ...entryLog, outcome: 'failed', error: e.message }); }
    }
    const decision = decide(channel, session, now, { settle, referee: archive.referees(ids), sent, maxSteps: segmentSteps(entry),
      margin: entry.answer_margin_seconds ?? 600, holds: holds(key, session) });
    if (decision.action === 'close') {
      await archive.close(ids, channel.status);
      memos.delete(key);
      anchors.delete(key);
      log({ game: key, action: 'close', status: channel.status });
      return;
    }
    if (decision.action === 'wait') return;
    const started = Date.now();
    const entryLog = { game: key, action: decision.action, epoch: channel.epoch, seq: decision.base?.env.seq };
    if (!chain.canSend) { log({ ...entryLog, outcome: 'skipped', error: 'watch-only: no keeper account' }); return; }
    const run = act(entry, ids, channel, decision, sent)
      .then(result => log({ ...entryLog, ...result, outcome: 'sent', ms: Date.now() - started }))
      .catch(e => log({ ...entryLog, outcome: 'failed', error: e.message, ms: Date.now() - started }))
      .finally(() => busy.delete(key));
    busy.set(key, run);
  }

  // Register a game that opened on `entry`'s channel if it is timed and names
  // our referee key. Returns whether to try again next round: after a failure
  // that may pass, such as an RPC error or a full keeper (503), but not once
  // the archive refuses the game (its other KeeperErrors, e.g. closed here).
  async function found(entry, gameId) {
    const key = gameKey(archive.ids(entry.channel, gameId));
    if (archive.known.has(key)) return false;
    try {
      const terms = await chain.terms(entry, gameId);
      if (terms.clock == null || felt(terms.clock.referee) !== archive.referee) return false;
      if ((await archive.register(new Session(entry.game, terms).export())).created)
        log({ game: key, action: 'register', outcome: 'opened' });
      return false;
    } catch (e) {
      const retry = !(e instanceof KeeperError) || e.status >= 500;
      log({ game: key, action: 'register', outcome: retry ? 'failed' : 'refused', error: e.message });
      return retry;
    }
  }

  // Register the timed games that opened on `entry`'s channel naming our
  // referee key, found in the world's `ChannelUpdated` events: each gets a
  // referee and a `start` even if neither seat registers it. The games still
  // to retry are kept in the store and go first, even with no new blocks.
  async function discover(entry) {
    const cursor = `${CURSOR}${hex(entry.channel)}`, retries = `${RETRY}${hex(entry.channel)}`;
    const from = (await archive.backend.get(cursor)) ?? entry.from_block ?? await chain.blockNumber();
    const pending = (await archive.backend.get(retries)) ?? [];
    const { games, to } = await chain.openedGames(entry, from);
    const failed = [];
    for (const gameId of new Set([...pending, ...games.map(g => g.game_id)]))
      if (await found(entry, gameId)) failed.push(gameId);
    // The retries before the cursor: a crash between the two only rescans.
    if (pending.length || failed.length) await archive.backend.put(retries, failed);
    if (to >= from) await archive.backend.put(cursor, to + 1);
  }

  async function tick() {
    if (archive.referee !== null && chain.openedGames) {
      for (const entry of entries.values()) {
        if (!entry.world || entry.anchored === false) continue;
        try { await discover(entry); } catch (e) {
          log({ action: 'discover', channel: hex(entry.channel), outcome: 'failed', error: e.message });
        }
      }
    }
    const now = await chain.now();
    for (const ids of archive.open()) {
      if (busy.has(gameKey(ids))) continue;
      try { await visit(ids, now); } catch (e) { log({ game: gameKey(ids), action: 'read', outcome: 'failed', error: e.message }); }
    }
  }

  const loop = async () => {
    try { await tick(); } catch (e) { log({ action: 'tick', outcome: 'failed', error: e.message }); }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  if (intervalMs > 0) timer = setTimeout(loop, 0);
  return {
    tick,
    idle: () => Promise.all(busy.values()),
    stop: async () => { stopped = true; clearTimeout(timer); await Promise.all(busy.values()); },
  };
}
