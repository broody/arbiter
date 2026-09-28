// JS mirror of referee/core/src/protocol.cairo. Every hash here must match the
// Cairo byte for byte; the counter example's fixtures test that.
import { ec, hash, shortString } from 'starknet';

export const PROTOCOL_VERSION = 3n;
export const NO_SEAT = 255;
/** The actor of a `flag` step: the referee of a timed game, not a seat. */
export const REFEREE = 254;
export const REASON_RESIGN = 128;
export const REASON_TIMEOUT = 129;
/** Upper bound on each time-control setting (ms): 30 days. */
export const MAX_CLOCK_MS = 2592000000;
/** Upper bound on byo-yomi periods. */
export const MAX_PERIODS = 255;
export const MOVE_PLAY = 0, MOVE_PLAY_RANDOM = 1, MOVE_REVEAL = 2, MOVE_RECOMMIT = 3, MOVE_RESIGN = 4, MOVE_FLAG = 5;

/**
 * A step is a `Move`. Only `resign` names its seat; every other move belongs to
 * the seat the state says is due (see `actorOf`), except `flag`, which the
 * referee of a timed game sends.
 */
export const play = action => ({ kind: MOVE_PLAY, action });
/** A game action that requests randomness, with the actor's next hash-chain value. */
export const playRandom = (action, entropy) => ({ kind: MOVE_PLAY_RANDOM, action, entropy });
export const reveal = value => ({ kind: MOVE_REVEAL, value });
export const recommit = tip => ({ kind: MOVE_RECOMMIT, tip });
export const resign = seat => ({ kind: MOVE_RESIGN, seat });
/** The due seat's time ran out (timed games; the referee's step). */
export const flag = () => ({ kind: MOVE_FLAG });

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
export const poseidon = values => BigInt(hash.computePoseidonHashOnElements(values.map(felt)));
export const signingHash = values => poseidon(values) & MASK250;
export const low128 = value => BigInt(value) & LOW128;

/** Cairo `Span<felt252>` serialization: length, then elements. */
export const span = values => [BigInt(values.length), ...values.map(felt)];

/** Cairo `Option<T>` Serde: variant 0 and the payload for Some, variant 1 for None. */
const option = (value, encode) => (value == null ? [1n] : [0n, ...encode(value)]);

/**
 * A timed game's `terms.clock`: `{ referee, settings }`, the referee's public
 * key and the settings of the game's time rules (`game.time`, `standardTime`
 * by default). `terms.clock` is `null` (or absent) for an untimed game.
 */
export const encodeTimeControl = (game, c) => [felt(c.referee), ...span(timeOf(game).encodeSettings(c.settings))];

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
    default: throw Error('Unknown move');
  }
}

export const actionHash = (game, context, seq, transcript, step) =>
  signingHash([tag(game.tag), tag('REFEREE_ACTION_V1'), felt(context), BigInt(seq), felt(transcript), ...encodeStep(game, step)]);

export const checkpointHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_CHECKPOINT_V1'), felt(context), BigInt(epoch), felt(stateHash)]);
export const reopenHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_REOPEN_V1'), felt(context), BigInt(epoch), felt(stateHash)]);
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
    ...span(env.rng_heads),
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
    clock: c == null ? null : { seats: timeOf(game).open(c.settings, terms.rng_tips.length), used: 0, stamp: 0 },
    outcome: { finished: false, winner: 0, reason: 0 },
    game: game.init(terms.config),
  };
}

export const due = (game, env) => env.pending.active ? env.pending.seat : game.due(env.game);

/** The seat a step belongs to (`actor` in protocol.cairo); REFEREE for `flag`. */
export function actorOf(game, env, step) {
  if (step.kind === MOVE_RESIGN) return Number(step.seat);
  if (step.kind === MOVE_FLAG) return REFEREE;
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
// charging anyone.
function charge(time, settings, clock, payer, reveal, stamp, isFlag, state) {
  if (stamp == null) {
    check(!isFlag, 'Flag needs a stamp');
    return { ...clock, stamp: 0 };
  }
  check(Number.isSafeInteger(stamp) && stamp > 0, 'Invalid stamp');
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
  if (timed) {
    check(env.clock != null, 'Untimed state');
    next.clock = charge(time, terms.clock.settings, env.clock, payer, env.pending.active, stamp, seat === REFEREE, env.game);
  } else {
    check(env.clock == null, 'Timed state');
    check(stamp == null && seat !== REFEREE, 'Untimed game');
  }
  const takeReveal = (s, value) => {
    check(value !== 0n && rngNext(value) === next.rng_heads[s], 'Invalid reveal');
    next.rng_heads[s] = value;
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
      next.pending = { active: true, seat: request, seq: next.seq, entropy };
      break;
    }
    case MOVE_REVEAL: {
      takeReveal(seat, felt(step.value));
      const s = seed(game, context, next.pending.seq, next.pending.entropy, step.value);
      next.pending = idle();
      next.game = game.resolve(config, next.game, s, scratch);
      break;
    }
    case MOVE_RECOMMIT:
      check(felt(step.tip) !== 0n, 'Invalid tip');
      next.rng_heads[seat] = felt(step.tip);
      break;
    case MOVE_RESIGN:
      next.pending = idle();
      next.outcome = forfeit(seat, REASON_RESIGN);
      break;
    case MOVE_FLAG:
      next.pending = idle();
      next.outcome = forfeit(payer, REASON_TIMEOUT);
      break;
    default: throw Error('Unknown move');
  }
  if (!next.outcome.finished) {
    const result = game.outcome(next.game);
    if (result !== null) next.outcome = { finished: true, winner: result[0], reason: result[1] };
  }
  // A turn ends when the game's due seat changes: settle the time it used,
  // and start the next one from nothing.
  if (timed && game.due(next.game) !== turnSeat) {
    const seats = time.settle(terms.clock.settings, next.clock.seats, turnSeat, next.clock.used, false, next.game);
    next.clock = { seats, used: 0, stamp: next.clock.stamp };
  }
  if (next.last_seat !== seat) next.support_turn += 1;
  next.last_seat = seat;
  next.seq += 1;
  next.transcript = poseidon([next.transcript, message]);
  return { env: next, message, seat };
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
 * `attestation`, and the referee's `flag` records have seat REFEREE and a zero
 * signature. Our own timed steps wait in `pending` until they come back
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
   * As the referee of a timed game: stamp a seat's signed step, or a `flag`
   * step, at referee time `stamp`; attest the state it reaches; and apply it.
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
    // flag, or the other seat resigning) leaves every pending step off the
    // history.
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
    return { version: 3, terms: this.terms, start: this.start, witness: this.startWitness, steps };
  }
  /** Rebuild a session from `export()`, verifying every step. `lastSigned` is as for the constructor. */
  static import(game, record, { lastSigned } = {}) {
    check(record.version === 3, 'Unsupported transcript version');
    const session = new Session(game, record.terms, { start: record.start, witness: record.witness, lastSigned });
    for (const signed of record.steps) session.receive(signed);
    return session;
  }
}

/**
 * The earliest referee time at which the due seat of a timed game can be
 * flagged (once it has used more than its time rules allow), or null while
 * the clock is paused, the game is over or untimed.
 */
export function flagAt(game, terms, env) {
  const clock = env.clock;
  if (clock == null || clock.stamp === 0 || env.outcome.finished) return null;
  const seat = due(game, env), used = env.pending.active ? 0 : clock.used;
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
 */
export class Referee {
  constructor(session, privateKey, { now = Date.now() } = {}) {
    check(session.timed, 'Untimed game');
    check(publicKey(privateKey) === felt(session.terms.clock.referee), 'Wrong referee key');
    this.session = session;
    this.privateKey = privateKey;
    const last = session.env.clock.stamp;
    this.offset = last === 0 ? 0 : now - last;
  }

  /** Referee time at wall-clock `now`: never before the last stamp, never 0. */
  time(now = Date.now()) { return Math.max(now - this.offset, this.session.env.clock.stamp, 1); }

  /**
   * Stamp and apply a seat's signed step (`{ step, signature }`) arriving at
   * `now`. Throws 'Flag fell' once the due seat's time has run out: `flag` then.
   */
  stamp(signed, now = Date.now()) { return this.session.stamp(signed, this.time(now), this.privateKey); }

  /** The attested `flag` record once the due seat's time has run out at `now`, otherwise null. */
  flag(now = Date.now()) {
    const at = this.session.flagAt(), t = this.time(now);
    return at !== null && t >= at ? this.session.stamp({ step: flag(), signature: ZERO_SIGNATURE }, t, this.privateKey) : null;
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

// ---- Cairo Serde encoders and decoders for channel calldata ----

export const encodeSignature = sig => [felt(sig.r), felt(sig.s)];
export const encodeSignatures = sigs => [BigInt(sigs.length), ...sigs.flatMap(encodeSignature)];
export const encodeSteps = (game, list) => [BigInt(list.length), ...list.flatMap(s => encodeStep(game, s))];

/**
 * Each seat's last signature among signed step records (`{ seat, signature }`),
 * or ZERO_SIGNATURE for a seat with no step: what replay verifies. The
 * referee's `flag` records are skipped.
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

// A time control: the referee's key and the game's time-rule settings.
function readTimeControl(game, r) {
  const referee = r.next(), settings = new Reader(r.span());
  const decoded = { referee, settings: timeOf(game).decodeSettings(settings) };
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

/** The channel's `snapshot(game_id)`: terms, epoch, anchor hash, anchor block. */
export function decodeSnapshot(game, values) {
  const r = new Reader(values);
  const result = { terms: readTerms(game, r), epoch: r.num(), anchor_hash: r.next(), anchor_block: r.num() };
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
  // `referee` is zero for an untimed game.
  const referee = r.next(), settings = r.span();
  result.clock = referee === 0n ? null : { referee, settings: timeOf(game).decodeSettings(new Reader(settings)) };
  Object.assign(result, {
    anchor: readRef(r), candidate: readRef(r), anchor_block: r.num(), deadline: r.num(), result: readOutcome(r),
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
