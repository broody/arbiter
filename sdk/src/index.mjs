// JS mirror of referee/core/src/protocol.cairo. Every hash here must match the
// Cairo byte for byte; the counter example's fixtures test that.
import { ec, hash, shortString } from 'starknet';

export const PROTOCOL_VERSION = 2n;
export const NO_SEAT = 255;
export const REASON_RESIGN = 128;
export const REASON_TIMEOUT = 129;
export const MOVE_PLAY = 0, MOVE_PLAY_RANDOM = 1, MOVE_REVEAL = 2, MOVE_RECOMMIT = 3, MOVE_RESIGN = 4;

/**
 * A step is a `Move`. Only `resign` names its seat; every other move belongs to
 * the seat the state says is due (see `actorOf`).
 */
export const play = action => ({ kind: MOVE_PLAY, action });
/** A game action that requests randomness, with the actor's next hash-chain value. */
export const playRandom = (action, entropy) => ({ kind: MOVE_PLAY_RANDOM, action, entropy });
export const reveal = value => ({ kind: MOVE_REVEAL, value });
export const recommit = tip => ({ kind: MOVE_RECOMMIT, tip });
export const resign = seat => ({ kind: MOVE_RESIGN, seat });

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

/**
 * A game codec provides the Cairo Serde encodings of its types:
 * { tag, rulesVersion, encodeConfig(config), encodeAction(action), encodeState(state) },
 * plus `encodeWitness(witness)` if its replay takes a witness (see `load`).
 */
export function encodeTerms(game, t) {
  return [
    felt(t.chain_id), felt(t.channel), felt(t.game_id), felt(t.prover), BigInt(t.response_seconds),
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
    default: throw Error('Unknown move');
  }
}

export const actionHash = (game, context, seq, transcript, step) =>
  signingHash([tag(game.tag), tag('REFEREE_ACTION_V1'), felt(context), BigInt(seq), felt(transcript), ...encodeStep(game, step)]);

export const checkpointHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_CHECKPOINT_V1'), felt(context), BigInt(epoch), felt(stateHash)]);
export const reopenHash = (game, context, epoch, stateHash) =>
  signingHash([tag(game.tag), tag('REFEREE_REOPEN_V1'), felt(context), BigInt(epoch), felt(stateHash)]);

export function encodeEnvelope(game, env) {
  const p = env.pending;
  return [
    BigInt(env.seq), felt(env.transcript), BigInt(env.support_turn), BigInt(env.last_seat),
    p.active ? 1n : 0n, BigInt(p.seat), BigInt(p.seq), felt(p.entropy),
    ...span(env.rng_heads),
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
export function verify(message, signature, key) {
  try {
    const parsed = new ec.starkCurve.Signature(felt(signature.r), felt(signature.s));
    const x = felt(key).toString(16).padStart(64, '0');
    // Starknet keys are x-only; the Cairo verifier accepts either y parity.
    return ec.starkCurve.verify(parsed, hex(message), `02${x}`) || ec.starkCurve.verify(parsed, hex(message), `03${x}`);
  } catch { return false; }
}

const check = (condition, message) => { if (!condition) throw Error(message); };

export function open(game, config, rngTips) {
  check(rngTips.length === 2, 'Only 2 seats supported');
  return {
    seq: 0, transcript: 0n, support_turn: 0, last_seat: NO_SEAT,
    pending: { active: false, seat: 0, seq: 0, entropy: 0n },
    rng_heads: rngTips.map(felt),
    outcome: { finished: false, winner: 0, reason: 0 },
    game: game.init(config),
  };
}

export const due = (game, env) => env.pending.active ? env.pending.seat : game.due(env.game);

/** The seat a step belongs to (`actor` in protocol.cairo). */
export function actorOf(game, env, step) {
  if (step.kind === MOVE_RESIGN) return Number(step.seat);
  if (step.kind === MOVE_REVEAL) { check(env.pending.active, 'No reveal due'); return env.pending.seat; }
  check(!env.pending.active, 'Reveal pending');
  return game.due(env.game);
}

/**
 * Apply one step, mirroring `advance` in protocol.cairo. `game` provides
 * init/apply/resolve/due/outcome over plain JS state, and optionally
 * load/witness for games whose replay needs a witness (see `load`).
 * `scratch` is the game's working memory; `apply`/`resolve` may mutate it, so
 * pass a copy (`cloneScratch`) when the step might be rejected.
 * Returns { env, message, seat }.
 */
export function applyStep(game, context, config, env, step, scratch = null) {
  check(!env.outcome.finished, 'Game already finished');
  const seat = actorOf(game, env, step);
  check(seat === 0 || seat === 1, 'Invalid seat');
  const message = actionHash(game, context, env.seq, env.transcript, step);
  const next = structuredClone(env);
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
      next.pending = { active: false, seat: 0, seq: 0, entropy: 0n };
      next.game = game.resolve(config, next.game, s, scratch);
      break;
    }
    case MOVE_RECOMMIT:
      check(felt(step.tip) !== 0n, 'Invalid tip');
      next.rng_heads[seat] = felt(step.tip);
      break;
    case MOVE_RESIGN:
      next.pending = { active: false, seat: 0, seq: 0, entropy: 0n };
      next.outcome = { finished: true, winner: 2 - seat, reason: REASON_RESIGN };
      break;
    default: throw Error('Unknown move');
  }
  if (!next.outcome.finished) {
    const result = game.outcome(next.game);
    if (result !== null) next.outcome = { finished: true, winner: result[0], reason: result[1] };
  }
  if (next.last_seat !== seat) next.support_turn += 1;
  next.last_seat = seat;
  next.seq += 1;
  next.transcript = poseidon([next.transcript, message]);
  return { env: next, message, seat };
}

/** Apply unsigned steps from any seat (`apply_steps` in protocol.cairo). */
export function applySteps(game, context, config, start, witness, steps) {
  let env = start;
  const scratch = load(game, config, start.game, witness);
  for (const step of steps) env = applyStep(game, context, config, env, step, scratch).env;
  return env;
}

/** Build a game's working memory from its replay witness (`GameRules::load`). */
export const load = (game, config, state, witness) => (game.load ? game.load(config, state, witness) : null);
export const cloneScratch = (game, scratch) =>
  scratch === null ? null : game.cloneScratch ? game.cloneScratch(scratch) : structuredClone(scratch);

const normSignature = s => ({ r: felt(s.r), s: felt(s.s) });
export const ZERO_SIGNATURE = Object.freeze({ r: 0n, s: 0n });

/**
 * Replay signed steps from `start`, verifying every signature. Stricter than
 * the Cairo replay, which checks only each seat's final signature: clients
 * must never sign from a state they have not fully verified.
 */
export function replay(game, terms, start, witness, signed) {
  const context = contextHash(game, terms);
  let env = start;
  const scratch = load(game, terms.config, start.game, witness);
  for (const { step, signature } of signed) {
    const seat = actorOf(game, env, step);
    const message = actionHash(game, context, env.seq, env.transcript, step);
    check(verify(message, signature, terms.keys[seat]), 'Invalid session signature');
    env = applyStep(game, context, terms.config, env, step, scratch).env;
  }
  return { env, scratch };
}

/**
 * One client's view of a channel: the verified transcript from an anchor.
 * Holds public data only; private keys stay with the caller.
 *
 * Each step record is `{ seq, transcript, message, step, signature, seat }`:
 * the position the step was signed at, its message, the signed step and its
 * seat. `lastSigned[seat]` is the record of the last step this client signed
 * for that seat, or null; `sign` refuses to sign anything that would
 * contradict it. Persist it apart from the transcript (`@referee/sdk/store`
 * does) and pass it back in when restoring.
 */
export class Session {
  #staged = null;

  constructor(game, terms, { start, witness, lastSigned } = {}) {
    this.game = game;
    this.terms = terms;
    this.context = contextHash(game, terms);
    this.start = start ?? open(game, terms.config, terms.rng_tips);
    this.startWitness = witness ?? (game.openingWitness ? game.openingWitness(terms.config) : null);
    this.env = structuredClone(this.start);
    this.scratch = load(game, terms.config, this.start.game, this.startWitness);
    this.steps = [];
    this.lastSigned = lastSigned ? [...lastSigned] : [null, null];
  }

  /** Verify and apply a step signed by the other seat (or ourselves). */
  receive(signed) {
    const staged = this.#staged;
    this.#staged = null;
    if (staged?.record === signed && staged.base === this.env) return this.#commit(staged);
    // Authenticate before running any game logic on the step.
    const seat = actorOf(this.game, this.env, signed.step);
    check(seat === 0 || seat === 1, 'Invalid seat');
    const message = actionHash(this.game, this.context, this.env.seq, this.env.transcript, signed.step);
    check(verify(message, signed.signature, this.terms.keys[seat]), 'Invalid session signature');
    return this.#commit(this.#stage(signed.step, signed.signature, message));
  }

  /**
   * Sign our own step at the current state, after checking it against the
   * rules, without applying it: pass the result to `receive` (`move` does
   * both). Refuses to sign unless this session extends `lastSigned[seat]`,
   * because two different steps signed at one seq are equivocation: the other
   * seat could settle whichever branch suits it. Updates `lastSigned[seat]`.
   */
  sign(step, privateKey) {
    const seat = actorOf(this.game, this.env, step);
    check(seat === 0 || seat === 1, 'Invalid seat');
    check(publicKey(privateKey) === felt(this.terms.keys[seat]), 'Wrong signing key');
    const message = actionHash(this.game, this.context, this.env.seq, this.env.transcript, step);
    this.#guard(this.lastSigned[seat], message);
    this.#staged = this.#stage(step, sign(message, privateKey), message);
    this.lastSigned[seat] = this.#staged.record;
    return this.#staged.record;
  }

  /** Sign and apply our own step. */
  move(step, privateKey) { return this.receive(this.sign(step, privateKey)); }

  /** The transcript at `seq`, for `start.seq <= seq <= env.seq`; otherwise undefined. */
  transcriptAt(seq) {
    return seq === this.env.seq ? this.env.transcript : this.steps[seq - this.start.seq]?.transcript;
  }

  /** Whether this session's history passes through `{ seq, transcript }`, or starts after it. */
  includes({ seq, transcript }) {
    const at = this.transcriptAt(seq);
    return seq < this.start.seq || (at !== undefined && felt(at) === felt(transcript));
  }

  #guard(mark, message) {
    if (!mark || mark.seq < this.start.seq) return; // a later anchor supersedes it
    check(mark.seq <= this.env.seq, `Session is behind seq ${mark.seq}, which this key signed`);
    const at = mark.seq === this.env.seq ? { transcript: this.env.transcript, message } : this.steps[mark.seq - this.start.seq];
    check(felt(at.transcript) === felt(mark.transcript) && at.message === felt(mark.message),
      `Would equivocate: this key signed a different step at seq ${mark.seq}`);
  }

  // Apply a step to copies of the state, so a rejected step changes nothing.
  #stage(step, signature, message) {
    const scratch = cloneScratch(this.game, this.scratch);
    const { env, seat } = applyStep(this.game, this.context, this.terms.config, this.env, step, scratch);
    const record = { seq: this.env.seq, transcript: this.env.transcript, message, step, signature: normSignature(signature), seat };
    return { base: this.env, env, scratch, record };
  }

  #commit({ env, scratch, record }) {
    this.env = env;
    this.scratch = scratch;
    this.steps.push(record);
    return record;
  }

  /** Steps and one final signature per seat, as replay calldata takes them. */
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

  export() {
    const steps = this.steps.map(({ step, signature }) => ({ step, signature }));
    return { version: 2, terms: this.terms, start: this.start, witness: this.startWitness, steps };
  }
  /** Rebuild a session from `export()`, verifying every step. `lastSigned` is as for the constructor. */
  static import(game, record, { lastSigned } = {}) {
    check(record.version === 2, 'Unsupported transcript version');
    const session = new Session(game, record.terms, { start: record.start, witness: record.witness, lastSigned });
    for (const signed of record.steps) session.receive(signed);
    return session;
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
    env = applyStep(game, context, terms.config, env, session.steps[i].step, scratch).env;
  }
}

// ---- Cairo Serde encoders and decoders for channel calldata ----

export const encodeSignature = sig => [felt(sig.r), felt(sig.s)];
export const encodeSignatures = sigs => [BigInt(sigs.length), ...sigs.flatMap(encodeSignature)];
export const encodeSteps = (game, list) => [BigInt(list.length), ...list.flatMap(s => encodeStep(game, s))];

/**
 * Each seat's last signature among signed step records (`{ seat, signature }`),
 * or ZERO_SIGNATURE for a seat with no step: what replay verifies.
 */
export function finalSignatures(records, seats = 2) {
  const finals = Array.from({ length: seats }, () => ZERO_SIGNATURE);
  for (const r of records) {
    check(Number.isInteger(r.seat) && r.seat >= 0 && r.seat < seats, 'Step records need their seat; use session.steps');
    finals[r.seat] = normSignature(r.signature);
  }
  return finals;
}
/** A batch (`{ steps, signatures }`) from session step records (`session.steps`). */
export const batchOf = (records, seats = 2) => ({ steps: records.map(r => r.step), signatures: finalSignatures(records, seats) });
/**
 * A replay witness's Cairo Serde encoding. A game without `load` has the unit
 * witness `()`, which encodes to nothing.
 */
export function encodeWitness(game, witness) {
  if (game.encodeWitness) return game.encodeWitness(witness);
  check(!game.load, 'Game codec needs encodeWitness');
  return [];
}
/** Replay calldata: the steps, then one final signature per seat. */
export const encodeBatch = (game, { steps, signatures }) => [...encodeSteps(game, steps), ...encodeSignatures(signatures)];

class Reader {
  constructor(values) { this.values = values.map(BigInt); this.at = 0; }
  next() { check(this.at < this.values.length, 'Truncated encoding'); return this.values[this.at++]; }
  num() { return Number(this.next()); }
  bool() { return this.next() === 1n; }
  span() { const n = this.num(); return Array.from({ length: n }, () => this.next()); }
  done() { check(this.at === this.values.length, 'Trailing encoding'); }
}

/** A game's `decodeConfig(reader)` reads its `Config` from a Reader. */
export function readTerms(game, r) {
  return {
    chain_id: r.next(), channel: r.next(), game_id: r.next(), prover: r.next(), response_seconds: r.num(),
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
