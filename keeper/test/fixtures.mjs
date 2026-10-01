// Counter games and a fake chain for the keeper tests. No network access.
import { ec, typedData } from 'starknet';
import { Session, contextHash, due, play, publicKey, resign, signedStep, stateHash, tag } from '../../sdk/src/index.mjs';
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

/** The key the refereeing keeper signs with. */
export const REFEREE_KEY = 0x7e7e7en;
/** A timed game refereed with REFEREE_KEY: 30 s per turn and a 60 s bank, so a seat's time runs out 90 s into its turn. */
export const timed = (game_id = 7n) => ({ ...terms(game_id),
  clock: { referee: publicKey(REFEREE_KEY), settings: { turn_ms: 30000, bank_ms: 60000, increment_ms: 0, byoyomi: null }, rng_tip: 0n } });
/** The secret the refereeing keeper's randomness comes from. */
export const RNG_SECRET = 0x5ec2e7n;
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
export const signed = (session, from = 0) => session.steps.slice(from).map(signedStep);

/** A channel's stored reference to an envelope (`StateRef`). */
export const ref = env => ({ hash: stateHash(counter, env), seq: env.seq, support_turn: env.support_turn, due: due(counter, env), outcome: env.outcome });

/** A decoded `ChannelGame` for `session`'s terms. */
export function channelOf(session, { status = ACTIVE, epoch = 0, anchor = session.start, candidate = anchor, deadline = 0,
  acked_epoch = 0, acked_deadline = 0 } = {}) {
  return { id: session.terms.game_id, status, epoch, context: contextHash(counter, session.terms), anchor: ref(anchor),
    candidate: ref(candidate), deadline, anchor_block: 0, candidate_block: 0, acked_epoch, acked_deadline };
}

/**
 * Test wallets: each account's address is its key's Stark public key, and it
 * signs SNIP-12 messages as an OpenZeppelin account does, `[r, s]` over the
 * message hash.
 */
export const wallets = [0x5eed1n, 0x5eed2n];
const keyHex = key => `0x${key.toString(16)}`;
export const walletAddress = key => BigInt(ec.starkCurve.getStarkKey(keyHex(key)));
export function walletSign(key, message) {
  const signature = ec.starkCurve.sign(typedData.getMessageHash(message, walletAddress(key)), keyHex(key));
  return [signature.r, signature.s];
}

/**
 * The watcher's chain interface over settable channels, recording every send.
 * `failing` names the sends that throw, and `terms` for the terms reads;
 * `bundles` is whether a resolve's after-settle calls simulate with it;
 * `openings` (`{ game_id, block }`) and `termsOf` (game id -> terms) stand in
 * for the world's events and the system's `terms`, up to block `block`. A game
 * without a channel reads as one nobody opened (null).
 */
export function fakeChain({ canSend = true } = {}) {
  const channels = new Map(), sent = [], failing = new Set(), openings = [], termsOf = new Map();
  const accounts = new Map(wallets.map(key => [walletAddress(key), ec.starkCurve.getPublicKey(keyHex(key))]));
  const record = (via, entry) => {
    if (failing.has(via)) throw Error(`${via} failed`);
    sent.push({ via, ...entry });
  };
  return {
    channels, sent, failing, openings, termsOf, time: 1000, block: 10, bundles: true, reads: { terms: 0 }, canSend,
    async verifyMessage(address, message, [r, s]) {
      const key = accounts.get(BigInt(address));
      return Boolean(key) && ec.starkCurve.verify(new ec.starkCurve.Signature(BigInt(r), BigInt(s)),
        typedData.getMessageHash(message, BigInt(address)), key);
    },
    async now() { return this.time; },
    async channel(entry, gameId) {
      if (failing.has('channel')) throw Error('channel failed');
      const channel = channels.get(BigInt(gameId));
      return channel ? structuredClone(channel) : null;
    },
    async blockNumber() { return this.block; },
    async openedGames(entry, from) {
      return { games: openings.filter(j => j.block >= from && j.block <= this.block), to: this.block };
    },
    async terms(entry, gameId) {
      this.reads.terms += 1;
      if (failing.has('terms')) throw Error('terms failed');
      if (!termsOf.has(BigInt(gameId))) throw Error('Unknown channel');
      return structuredClone(termsOf.get(BigInt(gameId)));
    },
    async submitHistory(entry, session, epoch, { open = null } = {}) { record('history', { session, epoch, ...(open ? { open } : {}) }); return '0x1'; },
    async resolve(entry, gameId, epoch, { after = [] } = {}) {
      if (!after.length) { record('resolve', { gameId, epoch }); return { tx: '0x2' }; }
      if (this.bundles) { record('resolve', { gameId, epoch, after }); return { tx: '0x2', bundled: true }; }
      record('resolve', { gameId, epoch });
      record('calls', { calls: after });
      return { tx: '0x2', bundled: false, after_tx: '0x6' };
    },
    async settle(entry, session, epoch, { open = null } = {}) { record('proof', { session, epoch, ...(open ? { open } : {}) }); return '0x3'; },
    async acknowledge(entry, gameId, epoch, signature) { record('acknowledge', { gameId, epoch, signature }); return '0x4'; },
    async resumeByReferee(entry, gameId, epoch, signature) { record('resume', { gameId, epoch, signature }); return '0x5'; },
  };
}

export const entry = (overrides = {}) =>
  ({ channel: CHANNEL, game: counter, entrypoints: {}, replay_max_steps: 64, prover: null, ...overrides });
