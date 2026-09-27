// Counter games and a fake chain for the keeper tests. No network access.
import { Session, contextHash, due, play, publicKey, resign, stateHash, tag } from '../../sdk/src/index.mjs';
import { ADD, counter } from '../../sdk/examples/counter.mjs';
import { ACTIVE } from '../watch.mjs';

export { Session, counter };
export const keys = [0x1a2b3cn, 0x4d5e6fn];
export const CHAIN = tag('SN_TEST'), CHANNEL = 0xc4a11e1n;
export const terms = (game_id = 7n) => ({
  chain_id: CHAIN, channel: CHANNEL, game_id, prover: 0xad0b7e5n, response_seconds: 3600,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: [0x11n, 0x22n], config: { target: 20 },
});
export const add = amount => play({ kind: ADD, amount });
export { resign };

/** Each seat in turn adds `amounts`, signing with its own key. */
export function played(amounts, session = new Session(counter, terms())) {
  for (const amount of amounts) session.move(add(amount), keys[session.due()]);
  return session;
}
export const copy = session => Session.import(counter, structuredClone(session.export()));
/** A verified copy of `session`'s first `n` steps. */
export const prefix = (session, n) => {
  const record = structuredClone(session.export());
  return Session.import(counter, { ...record, steps: record.steps.slice(0, n) });
};
export const signed = (session, from = 0) => session.steps.slice(from).map(({ step, signature }) => ({ step, signature }));

/** A channel's stored reference to an envelope (`StateRef`). */
export const ref = env => ({ hash: stateHash(counter, env), seq: env.seq, support_turn: env.support_turn, due: due(counter, env), outcome: env.outcome });

/** A decoded `ChannelGame` for `session`'s terms. */
export function channelOf(session, { status = ACTIVE, epoch = 0, anchor = session.start, candidate = anchor, deadline = 0 } = {}) {
  return { id: session.terms.game_id, status, epoch, context: contextHash(counter, session.terms), anchor: ref(anchor),
    candidate: ref(candidate), deadline, anchor_block: 0 };
}

/** The watcher's chain interface over settable channels, recording every send. */
export function fakeChain({ canSend = true } = {}) {
  const channels = new Map(), sent = [];
  return {
    channels, sent, time: 1000, canSend,
    async now() { return this.time; },
    async channel(entry, gameId) {
      const channel = channels.get(BigInt(gameId));
      if (!channel) throw Error('Unknown channel');
      return structuredClone(channel);
    },
    async submitHistory(entry, session, epoch) { sent.push({ via: 'history', session, epoch }); return '0x1'; },
    async resolve(entry, gameId, epoch) { sent.push({ via: 'resolve', gameId, epoch }); return '0x2'; },
    async settle(entry, session, epoch) { sent.push({ via: 'proof', session, epoch }); return '0x3'; },
  };
}

export const entry = (overrides = {}) =>
  ({ channel: CHANNEL, game: counter, entrypoints: {}, max_history_steps: 64, prover: null, ...overrides });
