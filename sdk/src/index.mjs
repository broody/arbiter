// JS mirror of referee/core/src/protocol.cairo. Every hash here must match the
// Cairo byte for byte; the counter example's fixtures test that.
import { ec, shortString } from 'starknet';
import { poseidonHashMany } from './poseidon.mjs';

export const PROTOCOL_VERSION = 5n;
export const NO_SEAT = 255;
/** The actor of a `flag`, a `start` and a roll: the referee of a timed game, not a seat. */
export const REFEREE = 254;
export const REASON_RESIGN = 128;
/** The referee flagged the due seat of a timed game. */
export const REASON_TIMEOUT = 129;
/** The chain judged that the due seat missed its forced-play window (`claim_timeout`). */
export const REASON_ABANDON = 130;
/** A roll waited too long for a referee that was down, or every seat agreed to stop waiting: no result, not a draw. */
export const REASON_VOID = 131;
/** Upper bound on each time-control setting (ms): 30 days. */
export const MAX_CLOCK_MS = 2592000000;
/** Upper bound on byo-yomi periods. */
export const MAX_PERIODS = 255;
export const MOVE_PLAY = 0, MOVE_PLAY_RANDOM = 1, MOVE_REVEAL = 2, MOVE_RECOMMIT = 3, MOVE_RESIGN = 4, MOVE_FLAG = 5,
  MOVE_START = 6;

/**
 * A step is a `Move`. Only `resign` names its seat; every other move belongs to
 * the seat the state says is due (see `actorOf`), except `flag` and `start`,
 * which the referee of a timed game sends. So is a `reveal` when the game
 * takes its randomness from the referee (`terms.clock.rng_tip`).
 */
export const play = action => ({ kind: MOVE_PLAY, action });
/** A game action that requests randomness, with the actor's next hash-chain value. */
export const playRandom = (action, entropy) => ({ kind: MOVE_PLAY_RANDOM, action, entropy });
export const reveal = value => ({ kind: MOVE_REVEAL, value });
/** Replace the due seat's hash-chain tip: only after it revealed from its current one. */
export const recommit = tip => ({ kind: MOVE_RECOMMIT, tip });
export const resign = seat => ({ kind: MOVE_RESIGN, seat });
/** The due seat's time ran out (timed games; the referee's step). */
export const flag = () => ({ kind: MOVE_FLAG });
/** The referee starts or restarts the clock without charging anyone (timed games). */
export const start = () => ({ kind: MOVE_START });

const PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MASK250 = (1n << 250n) - 1n;
const LOW128 = (1n << 128n) - 1n;

export const felt = value => {
  const n = BigInt(value);
  if (n < 0n || n >= PRIME) throw Error(`Invalid felt: ${value}`);
  return n;
};
export const tag = value => BigInt(shortString.encodeShortString(value));
export const hex = value => `0x${BigInt(value).toString(16)}`;
export const poseidon = values => poseidonHashMany(values.map(felt));
export { POSEIDON_BACKEND } from './poseidon.mjs';
export const signingHash = values => poseidon(values) & MASK250;
export const low128 = value => BigInt(value) & LOW128;

/** Cairo `Span<felt252>` serialization: length, then elements. */
export const span = values => [BigInt(values.length), ...values.map(felt)];

/** Cairo `Option<T>` Serde: variant 0 and the payload for Some, variant 1 for None. */
const option = (value, encode) => (value == null ? [1n] : [0n, ...encode(value)]);

/**
 * A timed game's `terms.clock`: `{ referee, settings, rng_tip }`, the
 * referee's public key, the settings of the game's time rules (`game.time`,
 * `standardTime` by default), and the tip of the referee's hash chain when the
 * game takes its randomness from the referee (0 or absent when the seats
 * reveal to each other). `terms.clock` is `null` (or absent) for an untimed
 * game.
 */
export const encodeTimeControl = (game, c) =>
  [felt(c.referee), ...span(timeOf(game).encodeSettings(c.settings)), felt(c.rng_tip ?? 0)];

/**
 * A game codec provides the Cairo Serde encodings of its types:
 * { tag, rulesVersion, encodeConfig(config), encodeAction(action), encodeState(state) },
 * plus `encodeWitness(witness)` if its replay takes a witness (see `load`), and
 * `time`, its time rules (`ClockRules`), if not `standardTime`.
 */
export function encodeTerms(game, t) {
  return [
    felt(t.chain_id), felt(t.channel), felt(t.game_id), felt(t.prover), BigInt(t.response_seconds),
    ...option(t.clock, c => encodeTimeControl(game, c)),
    ...span(t.players), ...span(t.keys), ...span(t.rng_tips), ...game.encodeConfig(t.config),
  ];
}

export const contextHash = (game, terms) =>
  poseidon([tag(game.tag), tag('REFEREE_CHANNEL_V1'), PROTOCOL_VERSION, BigInt(game.rulesVersion), ...encodeTerms(game, terms)]);

/** Cairo `Move<A>` Serde: variant index, then payload. */
export function encodeStep(game, step) {
  switch (step.kind) {
    case MOVE_PLAY: return [0n, ...game.encodeAction(step.action)];
    case MOVE_PLAY_RANDOM: return [1n, ...game.encodeAction(step.action), felt(step.entropy)];
    case MOVE_REVEAL: return [2n, felt(step.value)];
    case MOVE_RECOMMIT: return [3n, felt(step.tip)];
    case MOVE_RESIGN: return [4n, BigInt(step.seat)];
    case MOVE_FLAG: return [5n];
    case MOVE_START: return [6n];
    default: throw Error('Unknown move');
  }
}

export const actionHash = (game, context, seq, transcript, step) =>
  signingHash([tag(game.tag), tag('REFEREE_ACTION_V1'), felt(context), BigInt(seq), felt(transcript), ...encodeStep(game, step)]);

export const checkpointHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_CHECKPOINT_V1'), felt(context), BigInt(epoch), felt(stateHash)]);
export const reopenHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_REOPEN_V1'), felt(context), BigInt(epoch), felt(stateHash)]);
/** What the referee of a timed game signs to show it is live during a dispute (`live_hash`). */
export const liveHash = (game, context, epoch, deadline) =>
  signingHash([tag(game.tag), tag('REFEREE_LIVE_V1'), felt(context), BigInt(epoch), BigInt(deadline)]);
/** What the referee of a timed game signs to return it from forced play on its own (`referee_resume_hash`). */
export const refereeResumeHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_RESUME_V1'), felt(context), BigInt(epoch), felt(stateHash)]);
/**
 * What the referee signs to commit its hash-chain tip to one game (`tip_hash`),
 * which the channel checks when the last seat joins. A seat must check it too
 * before it signs the terms of a game no channel anchors: a tip another seat
 * made up would let that seat know every roll.
 */
export const tipHash = (game, chainId, channel, gameId, tip) =>
  signingHash([tag(game.tag), tag('REFEREE_TIP_V1'), felt(chainId), felt(channel), felt(gameId), felt(tip)]);
/** What every seat signs to void a game whose roll waits for a referee that is down (`void_hash`). */
export const voidHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_VOID_V1'), felt(context), BigInt(epoch), felt(stateHash)]);
/**
 * What the referee of a timed game signs after each step (`stamp_hash`): the
 * transcript and the clocks `env` reached. The last attestation covers every
 * earlier stamp, since the clocks depend on all of them.
 */
export const stampHash = (game, context, env) =>
  signingHash([tag(game.tag), tag('REFEREE_STAMP_V1'), felt(context), BigInt(env.seq), felt(env.transcript), ...encodeClock(game, env.clock)]);

/**
 * What each seat's wallet signs to play a game that no channel anchors
 * onchain: SNIP-12 typed data naming the game and its terms' context hash.
 * The context binds every term, so the signature binds the wallet
 * (`terms.players[seat]`) to its session key (`terms.keys[seat]`), as creating
 * and joining a channel does onchain. Sign it with the wallet
 * (`account.signMessage`); a keeper checks it against the account contract.
 */
export function termsTypedData(game, terms) {
  return {
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' }, { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' }, { name: 'revision', type: 'shortstring' },
      ],
      Game: [{ name: 'game', type: 'shortstring' }, { name: 'game_id', type: 'felt' }, { name: 'context', type: 'felt' }],
    },
    primaryType: 'Game',
    domain: { name: 'referee', version: '1', chainId: shortString.decodeShortString(hex(terms.chain_id)), revision: '1' },
    message: { game: game.tag, game_id: hex(terms.game_id), context: hex(contextHash(game, terms)) },
  };
}

/**
 * A timed game's clock (`Clock`): `{ seats, used, stamp }`, each seat's clocks
 * as the game's time rules keep them, the time used in the current turn, and
 * the last stamp, in milliseconds.
 */
export const encodeClock = (game, c) => [...span(timeOf(game).encodeClock(c.seats)), BigInt(c.used), BigInt(c.stamp)];

export function encodeEnvelope(game, env) {
  const p = env.pending;
  return [
    BigInt(env.seq), felt(env.transcript), BigInt(env.support_turn), BigInt(env.last_seat),
    p.active ? 1n : 0n, BigInt(p.seat), BigInt(p.seq), felt(p.entropy),
    ...span(env.rng_heads), BigInt(env.rng_fresh.length), ...env.rng_fresh.map(f => (f ? 1n : 0n)),
    felt(env.rng_referee),
    ...option(env.clock, c => encodeClock(game, c)),
    env.outcome.finished ? 1n : 0n, BigInt(env.outcome.winner), BigInt(env.outcome.reason),
    ...game.encodeState(env.game),
  ];
}
export const stateHash = (game, env) => poseidon([tag(game.tag), tag('REFEREE_STATE_V1'), ...encodeEnvelope(game, env)]);

// Hash-chain randomness. A seat keeps its seed; the chain is c_0 = seed,
// c_{k+1} = rngNext(c_k), and it commits c_len as its tip. Reveals walk back.
export const rngNext = value => poseidon([tag('REFEREE_RNG_V1'), felt(value)]);
export function rngChain(seed, len) {
  const chain = [felt(seed)];
  for (let i = 0; i < len; i++) chain.push(rngNext(chain[i]));
  return chain; // chain[len] is the tip; reveal chain[len-1], chain[len-2], ...
}
export const seed = (game, context, seq, requester, revealer) =>
  poseidon([tag(game.tag), tag('REFEREE_SEED_V1'), felt(context), BigInt(seq), felt(requester), felt(revealer)]);

/**
 * A long hash chain kept as checkpoints, for a referee that holds one per
 * game: `tip` is the value it commits (`rngChain(seed, length)[length]`), and
 * `before(head)` the value that hashes to `head`. Building it costs `length`
 * hashes; it keeps one value in every `every`, and the stretch between two
 * checkpoints it last read. Reveals walk the chain back one value at a time,
 * so they cost about two hashes each.
 */
export class RngChain {
  #marks; #index = new Map(); #segment = null;

  constructor(seed, length, every = 64) {
    check(Number.isSafeInteger(length) && length > 0 && Number.isSafeInteger(every) && every > 0, 'Invalid chain');
    this.length = length;
    this.every = every;
    let value = felt(seed);
    this.#marks = [value];
    for (let i = 1; i <= length; i++) {
      value = rngNext(value);
      if (i % every === 0) this.#marks.push(value);
    }
    this.tip = value;
    this.#marks.forEach((mark, k) => this.#index.set(mark, k * every));
    this.#index.set(value, length);
  }

  // The chain from its checkpoint at `base` up to the next one, with each
  // value's place in the chain.
  #values(base) {
    if (this.#segment?.base !== base) {
      const values = [this.#marks[base / this.every]];
      while (values.length < this.every && base + values.length <= this.length) values.push(rngNext(values.at(-1)));
      this.#segment = { base, values, index: new Map(values.map((value, i) => [value, base + i])) };
    }
    return this.#segment.values;
  }

  /** The value that hashes to `head`, or null if `head` is not on the chain or is its first value. */
  before(head) {
    // Where `head` is: in the stretch last read, or a walk forward to the next checkpoint.
    let value = felt(head), at = this.#segment?.index.get(value) ?? null;
    for (let ahead = 0; ahead <= this.every && at === null; ahead++, value = rngNext(value)) {
      if (this.#index.has(value)) at = this.#index.get(value) - ahead;
    }
    if (at === null || at <= 0) return null;
    const base = at - 1 - (at - 1) % this.every;
    const found = this.#values(base)[at - 1 - base];
    return rngNext(found) === felt(head) ? found : null;
  }
}

const privateHex = key => `0x${felt(key).toString(16).padStart(64, '0')}`;
export const publicKey = privateKey => BigInt(ec.starkCurve.getStarkKey(privateHex(privateKey)));
export function sign(message, privateKey) {
  const sig = ec.starkCurve.sign(hex(message), privateHex(privateKey));
  return { r: sig.r, s: sig.s };
}
// Public keys, decompressed with both y parities (Starknet keys are x-only, and
// the Cairo verifier accepts either), the one that last verified first, each
// with a precomputed multiplication table. Verifying against a cached key is
// about ten times faster than decompressing it each time.
const { ProjectivePoint } = ec.starkCurve;
const ORDER = ec.starkCurve.CURVE.n;
const KEY_CACHE = 1024;
const keyPoints = new Map();
function pointsOf(key) {
  let points = keyPoints.get(key);
  if (points) keyPoints.delete(key);
  else {
    const x = key.toString(16).padStart(64, '0');
    points = ['02', '03'].map(parity => ProjectivePoint.fromHex(parity + x));
    for (const point of points) point._setWindowSize?.(4);
    if (keyPoints.size >= KEY_CACHE) keyPoints.delete(keyPoints.keys().next().value);
  }
  keyPoints.set(key, points);
  return points;
}
const invert = a => {
  let [t, next, r, rest] = [0n, 1n, ORDER, a % ORDER];
  while (rest !== 0n) {
    const q = r / rest;
    [t, next, r, rest] = [next, t - q * next, rest, r - q * rest];
  }
  return ((t % ORDER) + ORDER) % ORDER;
};

/** STARK-curve ECDSA verification, as Cairo's `check_ecdsa_signature` does it. */
export function verify(message, signature, key) {
  try {
    const z = felt(message), r = felt(signature.r), s = felt(signature.s);
    if (!(r > 0n && r < 1n << 251n && s > 0n && s < ORDER)) return false;
    const points = pointsOf(felt(key));
    const w = invert(s), u1 = (z * w) % ORDER, u2 = (r * w) % ORDER;
    const g = u1 === 0n ? ProjectivePoint.ZERO : ProjectivePoint.BASE.multiply(u1);
    for (let i = 0; i < points.length; i++) {
      if (g.add(points[i].multiply(u2)).toAffine().x !== r) continue;
      if (i > 0) points.reverse();
      return true;
    }
    return false;
  } catch { return false; }
}

const check = (condition, message) => { if (!condition) throw Error(message); };

/** Reject a time control a game could not be played under (`check_clock`). */
export function checkTimeControl(game, c) {
  if (c == null) return;
  check(felt(c.referee) !== 0n, 'Invalid referee');
  timeOf(game).check(c.settings);
}

/** The opening envelope for `terms` (`open` in protocol.cairo). */
export function open(game, terms) {
  check(terms.rng_tips.length === 2, 'Only 2 seats supported');
  check(terms.rng_tips.every(tip => felt(tip) !== 0n), 'Invalid tip');
  checkTimeControl(game, terms.clock);
  const c = terms.clock;
  return {
    seq: 0, transcript: 0n, support_turn: 0, last_seat: NO_SEAT,
    pending: { active: false, seat: 0, seq: 0, entropy: 0n },
    rng_heads: terms.rng_tips.map(felt),
    rng_fresh: terms.rng_tips.map(() => true),
    rng_referee: c == null ? 0n : felt(c.rng_tip ?? 0),
    clock: c == null ? null : { seats: timeOf(game).open(c.settings, terms.rng_tips.length), used: 0, stamp: 0 },
    outcome: { finished: false, winner: 0, reason: 0 },
    game: game.init(terms.config),
  };
}

/** The seat due to act, including a pending reveal: REFEREE while the referee owes a roll. */
export const due = (game, env) => env.pending.active ? env.pending.seat : game.due(env.game);

/** The seat a step belongs to (`actor` in protocol.cairo); REFEREE for `flag`, `start` and the referee's roll. */
export function actorOf(game, env, step) {
  if (step.kind === MOVE_RESIGN) return Number(step.seat);
  if (step.kind === MOVE_FLAG || step.kind === MOVE_START) return REFEREE;
  if (step.kind === MOVE_REVEAL) { check(env.pending.active, 'No reveal due'); return env.pending.seat; }
  check(!env.pending.active, 'Reveal pending');
  return game.due(env.game);
}

const idle = () => ({ active: false, seat: 0, seq: 0, entropy: 0n });

/** The outcome when `seat` concedes or runs out of time (`forfeit`): the other seat wins. */
export const forfeit = (seat, reason) => ({ finished: true, winner: 2 - seat, reason });

// Charge the time since the last stamp to `payer`, mirroring `charge` in
// protocol.cairo: the turn seat's time adds to the turn's `used`, and a pending
// reveal is a one-step turn for the revealer, settled at once. An unstamped step
// pauses the clock, and the first stamp after a pause starts it without
// charging anyone. A `start` restarts the clock at its stamp and charges
// nobody. Nor does any step while the referee owes a roll (`payer` is
// REFEREE): that wait is nobody's time. `refereeStep` is MOVE_FLAG,
// MOVE_START, MOVE_REVEAL (the referee's roll) or null; only a roll may go
// unstamped.
function charge(time, settings, clock, payer, reveal, stamp, refereeStep, state) {
  if (stamp == null) {
    check(refereeStep == null || refereeStep === MOVE_REVEAL, 'Referee step needs a stamp');
    return { ...clock, stamp: 0 };
  }
  check(Number.isSafeInteger(stamp) && stamp > 0, 'Invalid stamp');
  const isFlag = refereeStep === MOVE_FLAG;
  if (refereeStep === MOVE_START || payer === REFEREE) {
    check(stamp >= clock.stamp, 'Stamp out of order');
    return { ...clock, stamp };
  }
  if (clock.stamp === 0) {
    check(!isFlag, 'Clock not running');
    return { ...clock, stamp };
  }
  check(stamp >= clock.stamp, 'Stamp out of order');
  const elapsed = stamp - clock.stamp;
  const used = reveal ? elapsed : clock.used + elapsed;
  const expired = used > time.limit(settings, clock.seats, payer, state);
  if (isFlag) {
    check(expired, 'Clock not expired');
    return { ...clock, stamp };
  }
  check(!expired, 'Flag fell');
  if (reveal) return { ...clock, seats: time.settle(settings, clock.seats, payer, elapsed, true, state), stamp };
  return { ...clock, used, stamp };
}

/**
 * Apply one step, mirroring `advance` in protocol.cairo. `game` provides
 * init/apply/resolve/due/outcome over plain JS state, and optionally
 * load/witness for games whose replay needs a witness (see `load`).
 * `scratch` is the game's working memory; `apply`/`resolve` may mutate it, so
 * pass a copy (`cloneScratch`) when the step might be rejected. In a timed game
 * `stamp` is the referee's time for the step (ms); an unstamped step pauses
 * the clock. Returns { env, message, seat }.
 */
export function applyStep(game, context, terms, env, step, scratch = null, stamp = null) {
  check(!env.outcome.finished, 'Game already finished');
  const seat = actorOf(game, env, step);
  check(seat === 0 || seat === 1 || seat === REFEREE, 'Invalid seat');
  const { config } = terms, timed = terms.clock != null, time = timeOf(game);
  const message = actionHash(game, context, env.seq, env.transcript, step);
  const next = structuredClone(env);
  // The seat on the clock, and the seat whose turn it is.
  const payer = due(game, env), turnSeat = game.due(env.game);
  const refereeStep = step.kind === MOVE_FLAG || step.kind === MOVE_START || (step.kind === MOVE_REVEAL && seat === REFEREE)
    ? step.kind : null;
  // The referee owes a roll: nobody's time is running.
  check(step.kind !== MOVE_FLAG || payer !== REFEREE, 'Roll pending');
  if (timed) {
    check(env.clock != null, 'Untimed state');
    next.clock = charge(time, terms.clock.settings, env.clock, payer, env.pending.active, stamp, refereeStep, env.game);
  } else {
    check(env.clock == null, 'Timed state');
    // Replay authenticates referee steps only through a timed game's attestation.
    check(stamp == null && refereeStep == null, 'Untimed game');
  }
  const takeReveal = (s, value) => {
    check(value !== 0n && rngNext(value) === next.rng_heads[s], 'Invalid reveal');
    next.rng_heads[s] = value;
    next.rng_fresh[s] = false;
  };
  switch (step.kind) {
    case MOVE_PLAY: {
      const [state, request] = game.apply(config, next.game, seat, step.action, scratch);
      check(request === null, 'Randomness requested');
      next.game = state;
      break;
    }
    case MOVE_PLAY_RANDOM: {
      const [state, request] = game.apply(config, next.game, seat, step.action, scratch);
      check(request !== null, 'Unexpected entropy');
      check(request !== seat && request < 2, 'Invalid reveal seat');
      next.game = state;
      const entropy = felt(step.entropy);
      takeReveal(seat, entropy);
      // A game that takes its randomness from the referee waits for the
      // referee's value, whichever seat the rules name.
      next.pending = { active: true, seat: next.rng_referee === 0n ? request : REFEREE, seq: next.seq, entropy };
      break;
    }
    case MOVE_REVEAL: {
      if (seat === REFEREE) {
        check(felt(step.value) !== 0n && rngNext(step.value) === next.rng_referee, 'Invalid reveal');
        next.rng_referee = felt(step.value);
      } else takeReveal(seat, felt(step.value));
      const s = seed(game, context, next.pending.seq, next.pending.entropy, step.value);
      next.pending = idle();
      next.game = game.resolve(config, next.game, s, scratch);
      break;
    }
    case MOVE_RECOMMIT:
      check(felt(step.tip) !== 0n, 'Invalid tip');
      // Once per reveal: otherwise a seat could add steps at will.
      check(!next.rng_fresh[seat], 'Nothing revealed to recommit');
      next.rng_heads[seat] = felt(step.tip);
      next.rng_fresh[seat] = true;
      break;
    case MOVE_RESIGN:
      next.pending = idle();
      next.outcome = forfeit(seat, REASON_RESIGN);
      break;
    case MOVE_FLAG:
      next.pending = idle();
      next.outcome = forfeit(payer, REASON_TIMEOUT);
      break;
    case MOVE_START:
      break;
    default: throw Error('Unknown move');
  }
  if (!next.outcome.finished) {
    const result = game.outcome(next.game);
    if (result !== null) next.outcome = gameOutcome(result);
  }
  // The transcript cap (`GameRules::max_steps`), once no reveal is pending.
  if (!next.outcome.finished && !next.pending.active && env.seq + 1 >= game.maxSteps(config)) {
    next.outcome = gameOutcome(game.adjudicate(config, next.game));
  }
  // A turn ends when the game's due seat changes: settle the time it used,
  // and start the next one from nothing.
  if (timed && game.due(next.game) !== turnSeat) {
    const seats = time.settle(terms.clock.settings, next.clock.seats, turnSeat, next.clock.used, false, next.game);
    next.clock = { seats, used: 0, stamp: next.clock.stamp };
  }
  // Only seats count as signers: a referee step acknowledges nothing.
  if (seat !== REFEREE) {
    if (next.last_seat !== seat) next.support_turn += 1;
    next.last_seat = seat;
  }
  next.seq += 1;
  next.transcript = poseidon([next.transcript, message]);
  return { env: next, message, seat };
}

// A finished outcome as a game reports it (`game_outcome` in protocol.cairo).
function gameOutcome([winner, reason]) {
  check(Number.isInteger(winner) && winner >= 0 && winner <= 2, 'Invalid winner');
  check(Number.isInteger(reason) && reason >= 1 && reason < 128, 'Invalid finish reason');
  return { finished: true, winner, reason };
}

/** Apply unsigned steps from any seat (`apply_steps` in protocol.cairo), stamped when `stamps` is given. */
export function applySteps(game, context, terms, start, witness, steps, stamps = []) {
  check(stamps.length === 0 || stamps.length === steps.length, 'Wrong stamp count');
  let env = start;
  const scratch = load(game, terms.config, start.game, witness);
  steps.forEach((step, i) => { env = applyStep(game, context, terms, env, step, scratch, stamps[i] ?? null).env; });
  return env;
}

/** Build a game's working memory from its replay witness (`GameRules::load`). */
export const load = (game, config, state, witness) => (game.load ? game.load(config, state, witness) : null);
export const cloneScratch = (game, scratch) =>
  scratch === null ? null : game.cloneScratch ? game.cloneScratch(scratch) : structuredClone(scratch);

const normSignature = s => ({ r: felt(s.r), s: felt(s.s) });
export const ZERO_SIGNATURE = Object.freeze({ r: 0n, s: 0n });

/**
 * The part of a step record that travels: `{ step, signature }`, plus `stamp`
 * and the referee's `attestation` in a timed game.
 */
export const signedStep = ({ step, signature, stamp, attestation }) =>
  (stamp == null ? { step, signature } : { step, signature, stamp, attestation });

// Check a step's seat signature and stamp before running any game logic on it.
function authenticate(game, terms, context, env, signed) {
  const seat = actorOf(game, env, signed.step);
  check(seat === 0 || seat === 1 || seat === REFEREE, 'Invalid seat');
  const message = actionHash(game, context, env.seq, env.transcript, signed.step);
  if (seat !== REFEREE) check(verify(message, signed.signature, terms.keys[seat]), 'Invalid session signature');
  if (terms.clock != null) check(signed.stamp != null, 'Timed games need the referee\'s stamp on every step');
  else check(signed.stamp == null && signed.attestation == null, 'Stamp in an untimed game');
  return message;
}

// Check the referee's attestation of the state a timed step reached.
function attested(game, terms, context, env, attestation) {
  check(attestation != null && verify(stampHash(game, context, env), attestation, terms.clock.referee), 'Invalid referee attestation');
  return normSignature(attestation);
}

/**
 * Replay signed steps from `start`, verifying every signature, and in a timed
 * game every stamp's attestation. Stricter than the Cairo replay, which checks
 * only each seat's final signature and the referee's final attestation:
 * clients must never sign from a state they have not fully verified.
 */
export function replay(game, terms, start, witness, signed) {
  const context = contextHash(game, terms);
  let env = start;
  const scratch = load(game, terms.config, start.game, witness);
  for (const record of signed) {
    authenticate(game, terms, context, env, record);
    env = applyStep(game, context, terms, env, record.step, scratch, record.stamp ?? null).env;
    if (terms.clock != null) attested(game, terms, context, env, record.attestation);
  }
  return { env, scratch };
}

/**
 * One client's view of a channel: the verified transcript from an anchor.
 * Holds public data only; private keys stay with the caller.
 *
 * Each step record is `{ seq, transcript, message, step, signature, seat }`:
 * the position the step was signed at, its message, the signed step and its
 * seat. In a timed game records also carry the referee's `stamp` and
 * `attestation`, and the referee's own records (a flag, a start, a roll) have
 * seat REFEREE and a zero signature. Our own timed steps wait in `pending` until they come back
 * stamped, and we can sign ahead of them within our turn. `lastSigned[seat]` is the record of the last step this client signed
 * for that seat, or null; `sign` refuses to sign anything that would
 * contradict it. Persist it apart from the transcript (`@referee/sdk/store`
 * does) and pass it back in when restoring.
 */
export class Session {
  #staged = null;
  #pending = []; // our timed steps awaiting a stamp: { env, scratch, record } after each

  constructor(game, terms, { start, witness, lastSigned } = {}) {
    this.game = game;
    this.terms = terms;
    this.context = contextHash(game, terms);
    this.start = start ?? open(game, terms);
    this.startWitness = witness ?? (game.openingWitness ? game.openingWitness(terms.config) : null);
    this.env = structuredClone(this.start);
    this.scratch = load(game, terms.config, this.start.game, this.startWitness);
    this.steps = [];
    this.lastSigned = lastSigned ? [...lastSigned] : [null, null];
  }

  /** Whether the game is timed: every step then needs the referee's stamp. */
  get timed() { return this.terms.clock != null; }

  /** Our signed steps awaiting the referee's stamp (timed games), oldest first. */
  get pending() { return this.#pending.map(p => p.record); }

  /** The state after our pending steps, which we sign from: `env` when none wait. */
  get tip() { return this.#tip().env; }

  /**
   * Verify and apply a signed step, the other seat's or ours. In a timed game
   * the step comes from the referee with its `stamp` and `attestation`.
   */
  receive(signed) {
    const staged = this.#staged;
    this.#staged = null;
    if (staged?.record === signed && staged.base === this.env && !this.timed) return this.#commit(staged);
    const message = authenticate(this.game, this.terms, this.context, this.env, signed);
    const next = this.#stage(signed.step, signed.signature ?? ZERO_SIGNATURE, message, signed.stamp ?? null);
    if (this.timed) next.record.attestation = attested(this.game, this.terms, this.context, next.env, signed.attestation);
    return this.#commit(next);
  }

  /**
   * As the referee of a timed game: stamp a seat's signed step, or a step of
   * the referee's own (a flag, a start, a roll), at referee time `stamp`; attest the state it reaches; and apply it.
   * Returns the record to send to the seats. `Referee` chooses the stamps.
   */
  stamp(signed, stamp, privateKey) {
    check(this.timed, 'Untimed game');
    check(publicKey(privateKey) === felt(this.terms.clock.referee), 'Wrong referee key');
    this.#staged = null;
    const signature = signed.signature ?? ZERO_SIGNATURE;
    const message = authenticate(this.game, this.terms, this.context, this.env, { step: signed.step, signature, stamp });
    const next = this.#stage(signed.step, signature, message, stamp);
    next.record.attestation = normSignature(sign(stampHash(this.game, this.context, next.env), privateKey));
    return this.#commit(next);
  }

  /**
   * Sign our own step at the current state, after checking it against the
   * rules, without applying it: pass the result to `receive` (`move` does
   * both). Refuses to sign unless this session extends `lastSigned[seat]`,
   * because two different steps signed at one seq are equivocation: the other
   * seat could settle whichever branch suits it. Updates `lastSigned[seat]`.
   *
   * In a timed game the step joins `pending` until the referee's stamped
   * record comes back through `receive`. Stamps stay out of the transcript, so
   * the next step can be signed from the `tip` right away, through the rest of
   * our turn.
   */
  sign(step, privateKey) {
    const base = this.#tip();
    const seat = actorOf(this.game, base.env, step);
    check(seat === 0 || seat === 1, 'Invalid seat');
    check(publicKey(privateKey) === felt(this.terms.keys[seat]), 'Wrong signing key');
    const message = actionHash(this.game, this.context, base.env.seq, base.env.transcript, step);
    this.#guard(this.lastSigned[seat], message);
    const staged = this.#stage(step, sign(message, privateKey), message, null, base);
    this.lastSigned[seat] = staged.record;
    if (this.timed) this.#pending.push(staged);
    else this.#staged = staged;
    return staged.record;
  }

  /**
   * Stage our own signed steps that still await the referee's stamp, e.g.
   * from a store after a restart, skipping any the history already holds.
   * Stops at the first that does not follow the tip.
   */
  resume(records) {
    for (const record of records) {
      const base = this.#tip();
      if (record.seq < base.env.seq) continue;
      if (record.seq !== base.env.seq || felt(record.transcript) !== felt(base.env.transcript)) break;
      const seat = actorOf(this.game, base.env, record.step);
      const message = actionHash(this.game, this.context, base.env.seq, base.env.transcript, record.step);
      check(seat !== REFEREE && verify(message, record.signature, this.terms.keys[seat]), 'Invalid session signature');
      this.#pending.push(this.#stage(record.step, record.signature, message, null, base));
    }
  }

  /**
   * Sign and apply our own step, in an untimed game. In a timed game, `sign`
   * the step, send it to the referee and `receive` the stamped record back.
   */
  move(step, privateKey) {
    check(!this.timed, 'Timed games apply a step once the referee stamps it: sign, send, then receive');
    return this.receive(this.sign(step, privateKey));
  }

  /** The transcript at `seq`, for `start.seq <= seq <= env.seq`; otherwise undefined. */
  transcriptAt(seq) {
    return seq === this.env.seq ? this.env.transcript : this.steps[seq - this.start.seq]?.transcript;
  }

  /** Whether this session's history passes through `{ seq, transcript }`, or starts after it. */
  includes({ seq, transcript }) {
    const at = this.transcriptAt(seq);
    return seq < this.start.seq || (at !== undefined && felt(at) === felt(transcript));
  }

  /**
   * Forget our pending step `record` and any after it, as if never signed:
   * for a store whose write of it failed, so the signature never leaves.
   */
  discard(record) {
    const at = this.#pending.findIndex(p => p.record === record);
    if (at >= 0) this.#pending = this.#pending.slice(0, at);
  }

  // The history we sign from runs through our pending steps.
  #guard(mark, message) {
    if (!mark || mark.seq < this.start.seq) return; // a later anchor supersedes it
    const tip = this.#tip().env;
    check(mark.seq <= tip.seq, `Session is behind seq ${mark.seq}, which this key signed`);
    const at = mark.seq === tip.seq ? { transcript: tip.transcript, message }
      : [...this.steps, ...this.pending][mark.seq - this.start.seq];
    // The referee's step (a start, a roll) took that position before our step reached
    // it. Our step was never stamped, so no timed replay can use it: signing
    // on from here is no equivocation.
    if (at.seat === REFEREE && felt(at.transcript) === felt(mark.transcript)) return;
    check(felt(at.transcript) === felt(mark.transcript) && at.message === felt(mark.message),
      `Would equivocate: this key signed a different step at seq ${mark.seq}`);
  }

  #tip() { return this.#pending.at(-1) ?? { env: this.env, scratch: this.scratch }; }

  // Apply a step to copies of the state, so a rejected step changes nothing.
  #stage(step, signature, message, stamp = null, base = { env: this.env, scratch: this.scratch }) {
    const scratch = cloneScratch(this.game, base.scratch);
    const { env, seat } = applyStep(this.game, this.context, this.terms, base.env, step, scratch, stamp);
    const record = { seq: base.env.seq, transcript: base.env.transcript, message, step, signature: normSignature(signature), seat };
    if (stamp != null) record.stamp = stamp;
    return { base: base.env, env, scratch, record };
  }

  #commit({ env, scratch, record }) {
    this.env = env;
    this.scratch = scratch;
    this.steps.push(record);
    // Our oldest pending step came back stamped. Any other step at its seq (a
    // referee step, or the other seat resigning) leaves every pending step off
    // the history.
    const oldest = this.#pending[0];
    if (oldest) {
      if (oldest.record.seq === record.seq && oldest.record.message === record.message) this.#pending.shift();
      else this.#pending = [];
    }
    return record;
  }

  /** Steps, stamps and final signatures, as replay calldata takes them. */
  batch() { return batchOf(this.steps); }

  /** Witness for the current state, e.g. when it becomes the next anchor. */
  witness() { return this.game.witness ? this.game.witness(this.scratch) : null; }
  stateHash() { return stateHash(this.game, this.env); }
  due() { return due(this.game, this.env); }
  checkpointSignature(epoch, privateKey) {
    return sign(checkpointHash(this.game, this.context, epoch, this.stateHash()), privateKey);
  }
  reopenSignature(epoch, anchorHash, privateKey) {
    return sign(reopenHash(this.game, this.context, epoch, anchorHash), privateKey);
  }

  /** Referee time at which the due seat can be flagged (see `flagAt`), or null. */
  flagAt() { return flagAt(this.game, this.terms, this.env); }

  export() {
    const steps = this.steps.map(signedStep);
    return { version: 5, terms: this.terms, start: this.start, witness: this.startWitness, steps };
  }
  /** Rebuild a session from `export()`, verifying every step. `lastSigned` is as for the constructor. */
  static import(game, record, { lastSigned } = {}) {
    check(record.version === 5, 'Unsupported transcript version');
    const session = new Session(game, record.terms, { start: record.start, witness: record.witness, lastSigned });
    for (const signed of record.steps) session.receive(signed);
    return session;
  }
}

/**
 * The earliest referee time at which the due seat of a timed game can be
 * flagged (once it has used more than its time rules allow), or null while
 * the clock is paused, the referee owes a roll, the game is over or untimed.
 */
export function flagAt(game, terms, env) {
  const clock = env.clock;
  if (clock == null || clock.stamp === 0 || env.outcome.finished) return null;
  const seat = due(game, env), used = env.pending.active ? 0 : clock.used;
  if (seat === REFEREE) return null;
  return clock.stamp + timeOf(game).limit(terms.clock.settings, clock.seats, seat, env.game) - used + 1;
}

/**
 * Each seat's clock at referee time `at`, for display, as the game's time
 * rules show it (`view`; `standardTime` gives `{ turn, bank, periods, period }`).
 * The due seat's counts the time it has used since its turn began; the others
 * show what they start their next turn with. Null for an untimed game.
 */
export function timeLeft(game, terms, env, at) {
  const clock = env.clock, time = timeOf(game);
  if (clock == null || !time.view) return null;
  const seat = env.outcome.finished ? -1 : due(game, env);
  const live = (env.pending.active ? 0 : clock.used) + (clock.stamp === 0 ? 0 : Math.max(0, at - clock.stamp));
  return terms.rng_tips.map((_, s) => time.view(terms.clock.settings, clock.seats, s, s === seat ? live : 0, env.game));
}

/**
 * The standard time rules (`referee::clocks::StandardTime`), in milliseconds:
 * settings `{ turn_ms, bank_ms, increment_ms, byoyomi }` with `byoyomi` null
 * or `{ periods, period_ms }`, and clocks `{ banks, periods }` per seat. A
 * turn's time comes from `turn_ms` first, which does not carry over, then from
 * the bank (main time), then from byo-yomi periods; the bank gains
 * `increment_ms` when a turn ends.
 *
 * A game's time rules (`game.time`) mirror its Cairo `ClockRules`: `check`,
 * `open`, `limit` and `settle` over decoded values, the Serde codecs
 * `encodeSettings`, `decodeSettings(reader)` and `encodeClock`, and optionally
 * `view` for `timeLeft`.
 */
export const standardTime = {
  encodeSettings: s => [BigInt(s.turn_ms), BigInt(s.bank_ms), BigInt(s.increment_ms),
    ...option(s.byoyomi, b => [BigInt(b.periods), BigInt(b.period_ms)])],
  decodeSettings: r => ({ turn_ms: r.num(), bank_ms: r.num(), increment_ms: r.num(),
    byoyomi: r.num() === 0 ? { periods: r.num(), period_ms: r.num() } : null }),
  encodeClock: c => [BigInt(c.banks.length), ...c.banks.map(BigInt), BigInt(c.periods.length), ...c.periods.map(BigInt)],
  check(s) {
    const ms = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_CLOCK_MS;
    check([s.turn_ms, s.bank_ms, s.increment_ms].every(ms), 'Invalid time control');
    const b = s.byoyomi;
    if (b != null) {
      check(Number.isSafeInteger(b.periods) && b.periods > 0 && b.periods <= MAX_PERIODS && ms(b.period_ms) && b.period_ms > 0,
        'Invalid byo-yomi');
    }
    check(s.turn_ms > 0 || s.bank_ms > 0 || b != null, 'Invalid time control');
  },
  open: (s, seats) => ({ banks: Array(seats).fill(s.bank_ms), periods: s.byoyomi ? Array(seats).fill(s.byoyomi.periods) : [] }),
  limit: (s, c, seat) => s.turn_ms + c.banks[seat] + (s.byoyomi ? c.periods[seat] * s.byoyomi.period_ms : 0),
  settle(s, c, seat, used, reveal) {
    const banks = [...c.banks], periods = [...c.periods];
    const over = Math.max(0, used - s.turn_ms), fromBank = Math.min(over, banks[seat]), overtime = over - fromBank;
    // The period the turn ended in is not lost.
    if (s.byoyomi && overtime > 0) periods[seat] -= Math.floor((overtime - 1) / s.byoyomi.period_ms);
    banks[seat] += (reveal ? 0 : s.increment_ms) - fromBank;
    return { banks, periods };
  },
  view(s, c, seat, used) {
    const period = s.byoyomi?.period_ms ?? 0;
    const over = Math.max(0, used - s.turn_ms), fromBank = Math.min(over, c.banks[seat]), overtime = over - fromBank;
    const lost = overtime > 0 && period > 0 ? Math.floor((overtime - 1) / period) : 0;
    const periods = Math.max(0, (c.periods[seat] ?? 0) - lost);
    return { turn: Math.max(0, s.turn_ms - used), bank: c.banks[seat] - fromBank, periods,
      period: periods === 0 ? 0 : overtime > 0 ? (lost + 1) * period - overtime : period };
  },
};
const timeOf = game => game.time ?? standardTime;

/**
 * The referee of a timed game: stamps each seat's step as it arrives and flags
 * the due seat once that seat's time has run out. `session` is the referee's
 * verified copy of the game, which keeps every stamped step.
 *
 * Referee time is wall-clock milliseconds less an offset fixed when the
 * Referee is made: the clock resumes where the last stamp left it, so a
 * referee restarted from a stored session never charges a seat for its own
 * downtime. Keep one Referee per game for as long as the game runs.
 *
 * In a game that takes its randomness from the referee (`terms.clock.rng_tip`),
 * `rng` is the referee's hash chain for it: anything with `before(head)`, such
 * as an `RngChain`, whose tip is that `rng_tip`. The referee then reveals its
 * next value as soon as it stamps a step that asks for randomness.
 */
export class Referee {
  constructor(session, privateKey, { now = Date.now(), rng = null } = {}) {
    check(session.timed, 'Untimed game');
    check(publicKey(privateKey) === felt(session.terms.clock.referee), 'Wrong referee key');
    this.session = session;
    this.privateKey = privateKey;
    this.rng = rng;
    const last = session.env.clock.stamp;
    this.offset = last === 0 ? 0 : now - last;
  }

  /** Referee time at wall-clock `now`: never before the last stamp, never 0. */
  time(now = Date.now()) { return Math.max(now - this.offset, this.session.env.clock.stamp, 1); }

  /**
   * Stamp and apply a seat's signed step (`{ step, signature }`) arriving at
   * `now`. Throws 'Flag fell' once the due seat's time has run out: `flag` then.
   * If the step asks the referee for randomness, the roll follows it at once
   * (`roll`), as the session's next step.
   */
  stamp(signed, now = Date.now()) {
    // Never stamp a request for a roll this referee could not answer.
    if (signed.step?.kind === MOVE_PLAY_RANDOM && this.session.env.rng_referee !== 0n) this.#value();
    const record = this.session.stamp(signed, this.time(now), this.privateKey);
    this.roll(now);
    return record;
  }

  /**
   * The attested record of the roll the referee owes, its next hash-chain
   * value, or null when it owes none. `stamp` rolls by itself; call this for
   * a session that starts with a roll pending, e.g. one back from forced play.
   */
  roll(now = Date.now()) {
    const { pending } = this.session.env;
    if (!pending.active || pending.seat !== REFEREE) return null;
    return this.session.stamp({ step: reveal(this.#value()), signature: ZERO_SIGNATURE }, this.time(now), this.privateKey);
  }

  // The referee's next hash-chain value: the one that hashes to its head.
  #value() {
    const value = this.rng?.before(this.session.env.rng_referee) ?? null;
    check(value !== null, 'No hash-chain value for this roll');
    return value;
  }

  /** The attested `flag` record once the due seat's time has run out at `now`, otherwise null. */
  flag(now = Date.now()) {
    const at = this.session.flagAt(), t = this.time(now);
    return at !== null && t >= at ? this.session.stamp({ step: flag(), signature: ZERO_SIGNATURE }, t, this.privateKey) : null;
  }

  /**
   * The attested `start` record at `now`: the clock runs from here, and the
   * time since the last stamp is charged to no one. For a clock that is still
   * paused before the first move, and after play resumes from forced play.
   */
  start(now = Date.now()) {
    return this.session.stamp({ step: start(), signature: ZERO_SIGNATURE }, this.time(now), this.privateKey);
  }

  /** The referee's `acknowledge` signature for the dispute at `epoch` ending at `deadline`. */
  acknowledgement(epoch, deadline) {
    return sign(liveHash(this.session.game, this.session.context, epoch, deadline), this.privateKey);
  }

  /** The referee's signature returning the game from forced play at `epoch`, from the anchor `anchorHash`. */
  resumeSignature(epoch, anchorHash) {
    return sign(refereeResumeHash(this.session.game, this.session.context, epoch, anchorHash), this.privateKey);
  }

  /** Wall-clock time from which the due seat can be flagged, or null while the clock is paused or the game is over. */
  deadline() {
    const at = this.session.flagAt();
    return at === null ? null : at + this.offset;
  }
}

/**
 * `session` from the state whose hash is `anchorHash` (an anchor the channel
 * committed), keeping the steps after it; null if its history never reaches
 * that state. Proofs and onchain replays start from the channel's anchor.
 */
export function rebase(session, anchorHash) {
  const { game, terms, context } = session;
  const target = felt(anchorHash);
  let env = session.start;
  const scratch = load(game, terms.config, env.game, session.startWitness);
  for (let i = 0; ; i++) {
    if (stateHash(game, env) === target) {
      const witness = i === 0 ? session.startWitness : game.witness ? structuredClone(game.witness(scratch)) : null;
      const base = new Session(game, terms, { start: env, witness, lastSigned: session.lastSigned });
      for (const record of session.steps.slice(i)) base.receive(record);
      return base;
    }
    if (i === session.steps.length) return null;
    env = applyStep(game, context, terms, env, session.steps[i].step, scratch, session.steps[i].stamp ?? null).env;
  }
}

/** `session` cut to its first `n` steps after its start: a segment to submit. */
export function prefix(session, n) {
  if (n >= session.steps.length) return session;
  const base = new Session(session.game, session.terms, { start: session.start, witness: session.startWitness, lastSigned: session.lastSigned });
  for (const record of session.steps.slice(0, n)) base.receive(record);
  return base;
}

/** Whether `a` beats `b` as a dispute candidate (`channel::receive`): envelopes or channel references. */
export const outranks = (a, b) =>
  a.support_turn > b.support_turn || (a.support_turn === b.support_turn && a.seq > b.seq);

/**
 * What to submit against `channel` (a decoded `ChannelGame`) from `session`:
 * the session rebased on the channel's candidate when its history holds it,
 * so the answer extends the candidate, otherwise on the anchor; cut to
 * `maxSteps` steps; null when nothing there outranks the candidate. A seat
 * uses it to answer a dispute its opponent opened, and a keeper to settle a
 * long transcript in segments.
 */
export function disputeAnswer(session, channel, { maxSteps = Infinity } = {}) {
  const extends_ = felt(channel.candidate.hash) !== felt(channel.anchor.hash) ? rebase(session, channel.candidate.hash) : null;
  const base = extends_ ?? rebase(session, channel.anchor.hash);
  if (!base || base.steps.length === 0) return null;
  const answer = prefix(base, maxSteps);
  return outranks(answer.env, channel.candidate) ? answer : null;
}

// ---- Cairo Serde encoders and decoders for channel calldata ----

export const encodeSignature = sig => [felt(sig.r), felt(sig.s)];
export const encodeSignatures = sigs => [BigInt(sigs.length), ...sigs.flatMap(encodeSignature)];
export const encodeSteps = (game, list) => [BigInt(list.length), ...list.flatMap(s => encodeStep(game, s))];

/**
 * Each seat's last signature among signed step records (`{ seat, signature }`),
 * or ZERO_SIGNATURE for a seat with no step: what replay verifies. The
 * referee's own records are skipped.
 */
export function finalSignatures(records, seats = 2) {
  const finals = Array.from({ length: seats }, () => ZERO_SIGNATURE);
  for (const r of records) {
    if (r.seat === REFEREE) continue;
    check(Number.isInteger(r.seat) && r.seat >= 0 && r.seat < seats, 'Step records need their seat; use session.steps');
    finals[r.seat] = normSignature(r.signature);
  }
  return finals;
}
/**
 * A batch (`{ steps, stamps, signatures, attestation }`) from session step
 * records (`session.steps`): in a timed game each step's stamp and the last
 * record's attestation, otherwise no stamps and a zero attestation.
 */
export function batchOf(records, seats = 2) {
  const stamped = records.filter(r => r.stamp != null).length;
  check(stamped === 0 || stamped === records.length, 'Mixed stamped and unstamped steps');
  return {
    steps: records.map(r => r.step),
    stamps: stamped ? records.map(r => r.stamp) : [],
    signatures: finalSignatures(records, seats),
    attestation: stamped ? normSignature(records.at(-1).attestation) : ZERO_SIGNATURE,
  };
}
/**
 * A replay witness's Cairo Serde encoding. A game without `load` has the unit
 * witness `()`, which encodes to nothing.
 */
export function encodeWitness(game, witness) {
  if (game.encodeWitness) return game.encodeWitness(witness);
  check(!game.load, 'Game codec needs encodeWitness');
  return [];
}
/** Replay calldata (`Batch`): the steps, their stamps, one final signature per seat and the referee's attestation. */
export const encodeBatch = (game, { steps, stamps = [], signatures, attestation = ZERO_SIGNATURE }) =>
  [...encodeSteps(game, steps), BigInt(stamps.length), ...stamps.map(BigInt), ...encodeSignatures(signatures), ...encodeSignature(attestation)];

class Reader {
  constructor(values) { this.values = values.map(BigInt); this.at = 0; }
  next() { check(this.at < this.values.length, 'Truncated encoding'); return this.values[this.at++]; }
  num() { return Number(this.next()); }
  bool() { return this.next() === 1n; }
  span() { const n = this.num(); return Array.from({ length: n }, () => this.next()); }
  done() { check(this.at === this.values.length, 'Trailing encoding'); }
}

// A time control: the referee's key, the game's time-rule settings and the
// referee's randomness tip (0 when the seats reveal to each other).
function readTimeControl(game, r) {
  const referee = r.next(), settings = new Reader(r.span());
  const decoded = { referee, settings: timeOf(game).decodeSettings(settings), rng_tip: r.next() };
  settings.done();
  return decoded;
}

/** A game's `decodeConfig(reader)` reads its `Config` from a Reader. */
export function readTerms(game, r) {
  return {
    chain_id: r.next(), channel: r.next(), game_id: r.next(), prover: r.next(), response_seconds: r.num(),
    clock: r.num() === 0 ? readTimeControl(game, r) : null,
    players: r.span(), keys: r.span(), rng_tips: r.span(), config: game.decodeConfig(r),
  };
}
export const decodeTerms = (game, values) => { const r = new Reader(values); const t = readTerms(game, r); r.done(); return t; };

/**
 * The channel's `snapshot(game_id)`: terms, epoch, the anchor's hash and block,
 * and the candidate's. A proof starts from either.
 */
export function decodeSnapshot(game, values) {
  const r = new Reader(values);
  const result = { terms: readTerms(game, r), epoch: r.num(), anchor_hash: r.next(), anchor_block: r.num(),
    candidate_hash: r.next(), candidate_block: r.num() };
  r.done();
  return result;
}

const readOutcome = r => ({ finished: r.bool(), winner: r.num(), reason: r.num() });
const readRef = r => ({ hash: r.next(), seq: r.num(), support_turn: r.num(), due: r.num(), outcome: readOutcome(r) });

/** referee_dojo's `ChannelGame` model, as returned by a game's `get_channel`. */
export function decodeChannelGame(game, values) {
  const r = new Reader(values);
  const result = {
    id: r.next(), player_0: r.next(), player_1: r.next(), key_0: r.next(), key_1: r.next(),
    tip_0: r.next(), tip_1: r.next(), prover: r.next(),
  };
  const configFelts = r.span();
  result.config = game.decodeConfig(new Reader(configFelts));
  Object.assign(result, {
    status: r.num(), epoch: r.num(), context: r.next(), response_seconds: r.num(),
  });
  // `referee` is zero for an untimed game. Before the join, `rng_tip` is just
  // nonzero when the creator asked for the referee's randomness.
  const referee = r.next(), settings = r.span(), rng_tip = r.next();
  result.clock = referee === 0n ? null : { referee, settings: timeOf(game).decodeSettings(new Reader(settings)), rng_tip };
  Object.assign(result, {
    anchor: readRef(r), candidate: readRef(r), anchor_block: r.num(), candidate_block: r.num(), deadline: r.num(),
    acked_epoch: r.num(), acked_deadline: r.num(), result: readOutcome(r),
  });
  r.done();
  return result;
}
export { Reader };

// ---- Proof adapter (referee_adapter) ----

/** The L2->L1 payload a proved transition commits to (`prover::payload`). */
export function proofPayload(game, { classHash, prover, terms, context, epoch, startHash, endHash }) {
  return [felt(classHash), tag(game.tag), tag('REFEREE_PROVED_V1'), felt(terms.chain_id), felt(prover),
    felt(terms.channel), felt(terms.game_id), felt(context), BigInt(epoch), felt(startHash), felt(endHash)];
}
/** The message hash proof facts carry for `payload` sent by `prover` to L1 address 0. */
export const proofMessageHash = (prover, payload) => poseidon([felt(prover), 0n, BigInt(payload.length), ...payload]);
