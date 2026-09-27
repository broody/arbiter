// The keeper's chain loop. Each round reads the channel of every open game and:
// - answers a dispute whose candidate the archive outranks, before the deadline;
// - resolves a dispute once its window has passed (anyone may);
// - settles a finished game that is still active.
// It submits a transcript by onchain replay (`submit_history`) when short, or
// by a native proof through the game's adapter. Forced play and timeouts need
// a player's wallet, so the keeper only waits them out.
import { rebase } from '../sdk/src/index.mjs';
import { gameKey, outranks } from './archive.mjs';

export const WAITING = 0, ACTIVE = 1, DISPUTE = 2, FORCED = 3, SETTLED = 4, CANCELLED = 5;

/**
 * What to do about one game: `{ action, reason?, base? }`, where `action` is
 * close, wait, resolve, answer or settle. `base` is the archived session from
 * the channel's anchor (see `rebase`), for answer and settle. `baseFor(hash)`
 * defaults to rebasing `session`.
 */
export function decide(channel, session, now, { settle = true, baseFor = hash => rebase(session, hash) } = {}) {
  switch (channel.status) {
    case SETTLED: case CANCELLED: return { action: 'close' };
    case WAITING: return { action: 'wait', reason: 'not joined' };
    case FORCED: return { action: 'wait', reason: `forced play: seat ${channel.anchor.due} is due` };
  }
  if (channel.status === DISPUTE && now >= channel.deadline) return { action: 'resolve' };
  const finished = session.env.outcome.finished;
  if (channel.status === ACTIVE && !(settle && finished)) return { action: 'wait' };
  const base = baseFor(channel.anchor.hash);
  if (!base) return { action: 'wait', reason: 'the channel anchor is not in the archive' };
  if (base.env.seq <= channel.anchor.seq) return { action: 'wait', reason: 'nothing past the anchor' };
  if (channel.status === ACTIVE) return { action: 'settle', base };
  return outranks(base.env, channel.candidate) ? { action: 'answer', base } : { action: 'wait', reason: 'the candidate is current' };
}

/**
 * Watch the archive's open games against `chain` (see keeper/chain.mjs).
 * `entries` maps channel addresses (BigInt) to game entries. Returns
 * { tick, idle, stop }: `tick()` runs one round, `idle()` waits for actions in
 * flight.
 */
export function startWatcher({ archive, chain, entries, intervalMs = 15000, settle = true, log = () => {} }) {
  const busy = new Map(); // key -> action promise
  const bases = new Map(); // key -> { hash, seq, base }, so a round does not replay every transcript
  let timer = null, stopped = false;

  const baseFor = (key, session) => hash => {
    const cached = bases.get(key);
    if (cached?.hash === hash && cached.seq === session.env.seq && cached.session === session) return cached.base;
    const base = rebase(session, hash);
    bases.set(key, { hash, seq: session.env.seq, session, base });
    return base;
  };

  async function act(entry, ids, channel, decision) {
    const { action, base } = decision;
    if (action === 'resolve') return { tx: await chain.resolve(entry, ids.game_id, channel.epoch) };
    const via = base.steps.length <= entry.max_history_steps ? 'history' : entry.prover ? 'proof' : null;
    if (!via) throw Error(`${base.steps.length} steps exceed max_history_steps and no prover is configured`);
    const tx = via === 'history' ? await chain.submitHistory(entry, base, channel.epoch) : await chain.settle(entry, base, channel.epoch);
    return { tx, via, steps: base.steps.length };
  }

  async function visit(ids, now) {
    const key = gameKey(ids), entry = entries.get(ids.channel), session = await archive.session(ids);
    if (!entry || !session) return;
    const channel = await chain.channel(entry, ids.game_id);
    const decision = decide(channel, session, now, { settle, baseFor: baseFor(key, session) });
    if (decision.action === 'close') {
      await archive.close(ids, channel.status);
      bases.delete(key);
      log({ game: key, action: 'close', status: channel.status });
      return;
    }
    if (decision.action === 'wait') return;
    const started = Date.now();
    const entryLog = { game: key, action: decision.action, epoch: channel.epoch, seq: decision.base?.env.seq };
    if (!chain.canSend) { log({ ...entryLog, outcome: 'skipped', error: 'watch-only: no keeper account' }); return; }
    const run = act(entry, ids, channel, decision)
      .then(result => log({ ...entryLog, ...result, outcome: 'sent', ms: Date.now() - started }))
      .catch(e => log({ ...entryLog, outcome: 'failed', error: e.message, ms: Date.now() - started }))
      .finally(() => busy.delete(key));
    busy.set(key, run);
  }

  async function tick() {
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
