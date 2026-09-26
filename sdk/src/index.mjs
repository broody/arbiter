// JS mirror of referee/core/src/protocol.cairo. Every hash here must match the
// Cairo byte for byte; the counter example's fixtures test that.
import { ec, hash, shortString } from 'starknet';

export const PROTOCOL_VERSION = 1n;
export const NO_SEAT = 255;
export const REASON_RESIGN = 128;
export const REASON_TIMEOUT = 129;
export const MOVE_PLAY = 0, MOVE_REVEAL = 1, MOVE_RECOMMIT = 2, MOVE_RESIGN = 3;

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
 * { tag, rulesVersion, encodeConfig(config), encodeAction(action), encodeState(state) }.
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
export function encodeMove(game, move) {
  switch (move.kind) {
    case MOVE_PLAY: return [0n, ...game.encodeAction(move.action)];
    case MOVE_REVEAL: return [1n, felt(move.value)];
    case MOVE_RECOMMIT: return [2n, felt(move.tip)];
    case MOVE_RESIGN: return [3n];
    default: throw Error('Unknown move');
  }
}
export const encodeStep = (game, step) => [BigInt(step.seat), ...encodeMove(game, step.move), felt(step.entropy ?? 0n)];

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

/**
 * Apply one step, mirroring `transition` in protocol.cairo. `game` also
 * provides init/apply/resolve/due/outcome over plain JS state.
 * Returns { env, message }.
 */
export function applyStep(game, context, config, env, step) {
  const message = actionHash(game, context, env.seq, env.transcript, step);
  const next = structuredClone(env);
  check(!next.outcome.finished, 'Game already finished');
  const seat = step.seat;
  check(seat < 2, 'Invalid seat');
  const entropy = felt(step.entropy ?? 0n);
  const takeReveal = (s, value) => {
    check(value !== 0n && rngNext(value) === next.rng_heads[s], 'Invalid reveal');
    next.rng_heads[s] = value;
  };
  switch (step.move.kind) {
    case MOVE_PLAY: {
      check(!next.pending.active, 'Reveal pending');
      check(game.due(next.game) === seat, 'Not your turn');
      const [state, request] = game.apply(config, next.game, seat, step.move.action);
      next.game = state;
      if (request !== null) {
        check(request !== seat && request < 2, 'Invalid reveal seat');
        takeReveal(seat, entropy);
        next.pending = { active: true, seat: request, seq: next.seq, entropy };
      } else {
        check(entropy === 0n, 'Unexpected entropy');
      }
      break;
    }
    case MOVE_REVEAL: {
      check(entropy === 0n, 'Unexpected entropy');
      check(next.pending.active && next.pending.seat === seat, 'No reveal due');
      takeReveal(seat, felt(step.move.value));
      const s = seed(game, context, next.pending.seq, next.pending.entropy, step.move.value);
      next.pending = { active: false, seat: 0, seq: 0, entropy: 0n };
      next.game = game.resolve(config, next.game, s);
      break;
    }
    case MOVE_RECOMMIT:
      check(entropy === 0n, 'Unexpected entropy');
      check(!next.pending.active, 'Reveal pending');
      check(game.due(next.game) === seat, 'Not your turn');
      check(felt(step.move.tip) !== 0n, 'Invalid tip');
      next.rng_heads[seat] = felt(step.move.tip);
      break;
    case MOVE_RESIGN:
      check(entropy === 0n, 'Unexpected entropy');
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
  return { env: next, message };
}
