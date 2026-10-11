// Onchain ratings for arbiter games, as `arbiter_ratings` (ratings/) computes
// them: the integer rating update, pairing tickets, reads and calls on a
// ratings contract, and a replay that checks every rating from its events.
// Import as `@arbiter/sdk/ratings`. See RATINGS_PLAN.md.
//
// A game's ratings follow its `RatingRules`, which this module takes as a
// rules object, the mirror of the Cairo impl:
//
//   { tag, version, refereeRng,
//     pool(id) -> Pool | null, start(id, band) -> μ | null,
//     drift(id, μ) -> c, shown(id, μ, offset) -> number }
//
// `tag` is the game's short string (e.g. 'SURROUND'), `version` its
// `RatingRules::VERSION`. Pool ids reach the rules as felts (BigInt); the
// functions here also take them as short strings ('blitz'). A Pool is
//
//   { phi0, minPhi, muMin, muMax, provisionalPhi, settledGames, minSteps,
//     anchorPhi, anchorMuMin, anchorMuMax, maxOffset }
//
// with ratings and deviations in Q32.32 BigInt and the counts and the offset
// as numbers. A rating is { mu, phi, last }: μ and φ in Q32.32 logits
// (Glicko-2's μ scale), φ = 0 for a player never rated, `last` in seconds.
import { hash } from 'starknet';
import { Reader, felt, poseidon, sign, signingHash, tag } from './index.mjs';
import { contractCall } from './proving.mjs';

// ---- The update (ratings/src/math.cairo), bit for bit ----
//
// Variances are Q64 so that aging needs no square root. Every division rounds
// half to even: truncation biases ratings downward over millions of updates.
// Where Cairo panics (a negative `quot`, an unknown pool), this throws.

export const ONE = 1n << 32n;
const ONE2 = ONE * ONE, ONE3 = ONE2 * ONE;
const DAY = 86400n;
const LN2 = 2977044472n;                      // ln 2
const PI2 = 42389628127n;                     // π²
/** Idle seconds past which aging stops adding (long after any φ0 cap). */
const MAX_IDLE = 1n << 30n;
const EXP_STEP = ONE / 16n;
/** e^(−j/16) for j = 0…11, Q. */
const EXP_T = [4294967296n, 4034748382n, 3790295335n, 3560652950n, 3344923893n, 3142265200n,
  2951884975n, 2773039306n, 2605029347n, 2447198598n, 2298930330n, 2159645183n];
const EXP_CUT = 33n;                          // e^(−x) rounds to 0 once x ≥ 33·ln 2
const EXP_TERMS = 6n;

/** 1.15·2·ln 2 scaled by 2^64: c for a half-life of h days (Q) is `div(C_HALF_LIFE, h)` (KGS's drift). */
export const C_HALF_LIFE = 29408509883171471360n;
/** 400 / ln 10 in Q: Elo points per logit. */
export const ELO_SCALE = 746112238643n;
/** Signed values are stored biased in 40 bits: μ, peaks and pinned μ stay within ±2^39. */
export const BIAS_40 = 1n << 39n;
/** Deviations are stored in 34 bits: below 4. */
export const PHI_LIMIT = 1n << 34n;

/** n / d rounded half to even, d > 0. Symmetric in the sign of n. */
export function div(n, d) {
  if (d <= 0n) throw Error('Division by a non-positive number');
  if (n < 0n) return -div(-n, d);
  const q = n / d, r = n % d, r2 = r + r;
  return r2 > d || (r2 === d && (q & 1n)) ? q + 1n : q;
}

/** Floor of n / d, for n ≥ 0 and d > 0. */
export function quot(n, d) {
  if (n < 0n || d <= 0n) throw Error('quot takes n >= 0 and d > 0');
  return n / d;
}

/** The nearest integer to √n: the floor square root, plus one when n − r² > r. */
export function sqrt(n) {
  if (n <= 0n) return 0n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  return n - x * x > x ? x + 1n : x;
}

/** e^(−x) for x ≥ 0: x = n·ln 2 + r, and e^(−r) = T[j]·e^(−u) with u < 1/16, by Horner. */
export function expNeg(x) {
  const n = quot(x, LN2);
  if (n >= EXP_CUT) return 0n;
  const r = x - n * LN2, j = quot(r, EXP_STEP), u = r - j * EXP_STEP;
  let acc = ONE;
  for (let k = EXP_TERMS; k > 0n; k--) acc = ONE - div(u * acc, ONE * k);
  const e = div(EXP_T[Number(j)] * acc, ONE);
  return n === 0n ? e : div(e, 1n << n);
}

/** 1 / (1 + e^(−z)), Q. */
export function sigmoid(z) {
  if (z >= 0n) return div(ONE2, ONE + expNeg(z));
  const e = expNeg(-z);
  return div(e * ONE, ONE + e);
}

/** g = 1/√(1 + 3·var/π²) for a Q64 variance, Q. */
const gOf = variance => sqrt(div(ONE3, ONE + div(3n * variance, PI2)));

/** c for a half-life in days (Q): φ² grows by c² a day. */
export const driftOf = halfLife => div(C_HALF_LIFE, BigInt(halfLife));

/**
 * The Elo-scale rating for μ, 1500 + 173.7178·μ, rounded half to even, plus
 * `offset`, held to 0..65535 (`rules::elo`): the default `shown`.
 */
export function elo(mu, offset = 0) {
  const rating = div(1500n * ONE + div(ELO_SCALE * BigInt(mu), ONE), ONE) + BigInt(offset);
  return rating < 0n ? 0 : rating > 0xffffn ? 0xffff : Number(rating);
}

/**
 * Whether a pool's constants fit the packed player state and make sense
 * (`rules::valid_pool`): μ, peaks (μ − 2φ) and anchors within ±2^39,
 * deviations below 4.
 */
export function validPool(pool) {
  const p = normalizePool(pool);
  return p.minPhi > 0n
    && p.minPhi <= p.provisionalPhi
    && p.provisionalPhi <= p.phi0
    && p.phi0 < PHI_LIMIT
    && p.anchorPhi >= p.minPhi
    && p.anchorPhi < PHI_LIMIT
    && p.muMin < p.muMax
    && p.muMin - 2n * p.phi0 >= -BIAS_40
    && p.muMax < BIAS_40
    && p.anchorMuMin <= p.anchorMuMax
    && p.anchorMuMin >= p.muMin
    && p.anchorMuMax <= p.muMax
    && p.maxOffset >= 0;
}

const POOL_Q = ['phi0', 'minPhi', 'muMin', 'muMax', 'provisionalPhi', 'anchorPhi', 'anchorMuMin', 'anchorMuMax'];
const POOL_N = ['settledGames', 'minSteps', 'maxOffset'];
/** The Cairo `Pool`'s fields, in Serde order. */
const POOL_FIELDS = ['phi0', 'minPhi', 'muMin', 'muMax', 'provisionalPhi', 'settledGames', 'minSteps', 'anchorPhi',
  'anchorMuMin', 'anchorMuMax', 'maxOffset'];
function normalizePool(p) {
  const out = {};
  for (const k of POOL_Q) out[k] = BigInt(p[k]);
  for (const k of POOL_N) out[k] = Number(p[k]);
  return out;
}

/** A pool id as a felt: a short string such as 'blitz', or a felt. */
// A pool id or tag as a felt: a short string ('blitz'), or a felt as a number,
// BigInt or 0x-hex string (as JSON and RPC give them).
const shortOrFelt = x => (typeof x === 'string' && !/^0x[0-9a-f]+$/i.test(x) ? tag(x) : felt(x));
export const poolId = id => shortOrFelt(id);
const tagOf = value => shortOrFelt(value);

/** The rules' constants for a pool; throws for a pool the rules don't have. */
export function poolOf(rules, id) {
  const p = rules.pool(poolId(id));
  if (p == null) throw Error(`Unknown pool ${id}`);
  return normalizePool(p);
}

const ratingOf = x => ({ mu: BigInt(x.mu), phi: BigInt(x.phi), last: BigInt(x.last) });

/** A new player's state for a starting band, φ = 0 marking it never rated, or null for a band the pool lacks. */
export function start(rules, id, band) {
  const mu = rules.start(poolId(id), Number(band));
  return mu == null ? null : { mu: BigInt(mu), phi: 0n, last: 0n };
}

/**
 * The variance a player brings to a game at `t`: φ0² for a new player,
 * otherwise min(φ0², φ² + c²·idle days), c from the rules at the player's μ.
 */
function variance(rules, id, p, player, t) {
  const phi02 = p.phi0 * p.phi0;
  if (player.phi === 0n) return phi02;
  const base = player.phi * player.phi;
  if (t <= player.last) return base;
  let dt = t - player.last;
  if (dt > MAX_IDLE) dt = MAX_IDLE;
  const c = BigInt(rules.drift(id, player.mu));
  const aged = base + div(c * c * dt, DAY);
  return aged > phi02 ? phi02 : aged;
}

const clamp = (p, mu) => (mu < p.muMin ? p.muMin : mu > p.muMax ? p.muMax : mu);

function side(p, player, v, g, opponentMu, s, t) {
  const e = sigmoid(div(g * (player.mu - opponentMu), ONE));
  const info = div(div(g * g, ONE) * div(e * (ONE - e), ONE), ONE); // g²E(1 − E)
  const v2 = div(ONE3, div(ONE3, v) + info);                          // φ'², Q64
  const delta = div(div(v2 * g, ONE2) * (s - e), ONE);               // φ'²·g·(s − E)
  const phi = sqrt(v2);
  return { mu: clamp(p, player.mu + delta), phi: phi < p.minPhi ? p.minPhi : phi, last: player.last > t ? player.last : t };
}

function sides(p, a, b, va, vb, result, t) {
  const r = Number(result);
  const s = r === 0 ? 0n : r === 1 ? ONE / 2n : ONE;
  return { a: side(p, a, va, gOf(vb), b.mu, s, t), b: side(p, b, vb, gOf(va), a.mu, ONE - s, t) };
}

/**
 * One rated game in pool `id` (`math::update`). `a` and `b` are seat 0's and
 * seat 1's states (φ = 0: new, μ its band's start, from `start`); `result` is
 * seat 0's score in half points: 2 seat 0 won, 1 draw, 0 seat 1 won; `t` the
 * game's time in seconds. Returns both new states and P(seat 0 wins) before
 * the game, Q: `{ a, b, p }`.
 */
export function update(rules, id, a, b, result, t) {
  const pool = poolId(id), p = poolOf(rules, pool);
  [a, b, t] = [ratingOf(a), ratingOf(b), BigInt(t)];
  const va = variance(rules, pool, p, a, t), vb = variance(rules, pool, p, b, t);
  const q = sigmoid(div(gOf(va + vb) * (a.mu - b.mu), ONE));
  return { ...sides(p, a, b, va, vb, result, t), p: q };
}

/** `update` without P(seat 0 wins), as the contract runs it: `{ a, b }`. */
export function updateStates(rules, id, a, b, result, t) {
  const pool = poolId(id), p = poolOf(rules, pool);
  [a, b, t] = [ratingOf(a), ratingOf(b), BigInt(t)];
  return sides(p, a, b, variance(rules, pool, p, a, t), variance(rules, pool, p, b, t), result, t);
}

/** φ aged to `t`, as a game at `t` would use it; φ0 for a player never rated (`math::aged_phi`). */
export function agedPhi(rules, id, player, t) {
  const pool = poolId(id);
  return sqrt(variance(rules, pool, poolOf(rules, pool), ratingOf(player), BigInt(t)));
}

/**
 * A rated player's state aged to `t` without a game (`math::age`): φ grows as
 * it would for a game at `t`, and the clock moves to `t`. For the side of a
 * game that doesn't count for it.
 */
export function age(rules, id, player, t) {
  const x = ratingOf(player);
  t = BigInt(t);
  return { mu: x.mu, phi: agedPhi(rules, id, x, t), last: x.last > t ? x.last : t };
}

/** Settled: `settledGames` games or more, and aged φ at most `provisionalPhi` (`math::settled`). */
export function settled(rules, id, player, games, t) {
  const p = poolOf(rules, id);
  return Number(games) >= p.settledGames && agedPhi(rules, id, player, t) <= p.provisionalPhi;
}

/** "?" while φ is above the pool's `provisionalPhi` or the player lacks a win or a loss (`math::provisional`). */
export const provisional = (pool, phi, wins, losses) =>
  BigInt(phi) > normalizePool(pool).provisionalPhi || Number(wins) === 0 || Number(losses) === 0;

/** An anchor as a game at `t` sees it: its pinned μ and the pool's anchor deviation, never aged. */
export const anchorRating = (rules, id, mu, t) => ({ mu: BigInt(mu), phi: poolOf(rules, id).anchorPhi, last: BigInt(t) });

// ---- Pairing tickets (ratings/src/ticket.cairo) ----

/**
 * The digest's domain tag, which versions the ticket's format: a ticket of
 * another layout comes with another tag, and `TICKET_FORMATS` keeps each.
 */
export const PAIRING_V1 = 'ARBITER_PAIRING_V1';
/** A ticket's source: the quick-match queue or a brokered open table. */
export const QUEUE = 1, TABLE = 2;
/** Longest a ticket may live, from pairing to the deadline for its game's start, in seconds. */
export const MAX_TICKET_LIFE = 900;
/** How far apart the clocks dating a rated game may be, in seconds. */
export const MAX_CLOCK_SKEW = 60;
/** `GameVoided.reason` values. */
export const VOID_INVALID = 1, VOID_MATCHMAKER = 2, VOID_REFEREE = 3, VOID_SHORT = 4, VOID_ANCHOR = 5;

const NUMBERS_V1 = new Set(['response_seconds', 'source', 'band_0', 'band_1']);
/** Ticket layouts by domain tag: the Cairo `Ticket`'s fields, in Serde order, each one felt. */
export const TICKET_FORMATS = {
  [PAIRING_V1]: ['chain_id', 'channel', 'player_0', 'player_1', 'pool', 'config', 'referee', 'clock', 'prover',
    'response_seconds', 'source', 'band_0', 'band_1', 'matchmaker', 'issued_at', 'expires_at', 'nonce'],
};
const formatOf = domain => {
  const fields = TICKET_FORMATS[domain];
  if (!fields) throw Error(`Unknown ticket format ${domain}`);
  return fields;
};

/**
 * A ticket's Serde encoding, field for field `arbiter_ratings::Ticket`:
 * { chain_id, channel, player_0, player_1, pool, config, referee, clock,
 *   prover, response_seconds, source, band_0, band_1, matchmaker, issued_at,
 *   expires_at, nonce }, where `pool` is a short string or felt, `config` the
 * game's config hash (`configHash`) and `clock` its clock settings' hash
 * (`clockHash`).
 */
export const ticketFields = (ticket, domain = PAIRING_V1) =>
  formatOf(domain).map(k => (k === 'pool' ? poolId(ticket.pool) : felt(ticket[k])));

/** A ticket from its Serde encoding (`ticketFields`' inverse), e.g. from a `TicketUsed` event. */
export function decodeTicket(values, domain = PAIRING_V1) {
  const r = new Reader(values), ticket = {};
  for (const k of formatOf(domain)) ticket[k] = NUMBERS_V1.has(k) ? r.num() : r.next();
  r.done();
  return ticket;
}

/**
 * The message the matchmaker signs (`ticket::digest`): arbiter's 250-bit
 * signing hash over the domain tag, the game's rules tag (`rules.tag`), the
 * ratings contract that accepts the ticket and the ticket's fields.
 */
export const ticketDigest = (ticket, rulesTag, ratingsAddress, domain = PAIRING_V1) =>
  signingHash([tag(domain), tagOf(rulesTag), felt(ratingsAddress), ...ticketFields(ticket, domain)]);
export const signTicket = (ticket, rulesTag, ratingsAddress, privateKey, domain = PAIRING_V1) =>
  sign(ticketDigest(ticket, rulesTag, ratingsAddress, domain), privateKey);

/**
 * The hash a ticket fixes a game's config by (`arbiter::config_hash`):
 * Poseidon over the game's tag, 'ARBITER_CONFIG_V1' and the config's Serde
 * encoding with its ticket set to 0 (`game.encodeConfig({ ...config, ticket: 0 })`).
 */
export const configHash = (gameTag, configFelts) => poseidon([tagOf(gameTag), tag('ARBITER_CONFIG_V1'), ...configFelts]);

/**
 * The hash a ticket fixes a clock's settings by, as `clock_presets` keys them:
 * Poseidon over the settings' Serde encoding (`game.time.encodeSettings`, or
 * `standardTime.encodeSettings`), with no length prefix.
 */
export const clockHash = settingsFelts => poseidon(settingsFelts);

// ---- Calls and reads ----

const PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const signed = v => (BigInt(v) > (1n << 250n) ? BigInt(v) - PRIME : BigInt(v));

/**
 * A game channel's `rate(game_id, ticket)`, which reports a settled rated game
 * to the ratings contract with its `ticket` (from `TicketUsed`, or the
 * matchmaker). Anyone may send it.
 */
export const rateCall = (channel, gameId, ticket, entrypoint = 'rate') =>
  contractCall(channel, entrypoint, [felt(gameId), ...ticketFields(ticket)]);

/** A `Player` from its Serde encoding: μ, φ and the peak in Q32.32, the record and the rank shown. */
export function decodePlayer(values) {
  const r = new Reader(values);
  const player = { mu: signed(r.next()), phi: r.next(), last_played: r.next(), games: r.num(), wins: r.num(),
    losses: r.num(), draws: r.num(), shown: r.num(), provisional: r.bool(), established: r.bool(), settled: r.bool(),
    peak: signed(r.next()), has_peak: r.bool(), band: r.num(), params: r.num(), anchor: r.bool() };
  r.done();
  return player;
}

/** A pool's constants from their Serde encoding, as a rules object returns them. */
export function decodePool(values) {
  const r = new Reader(values), pool = {};
  for (const k of POOL_FIELDS) pool[k] = POOL_N.includes(k) ? Number(signed(r.next())) : signed(r.next());
  r.done();
  return pool;
}

/**
 * A player's rating and record in `pool`. An anchor shows its pin, with no
 * games; a player never rated reads as zeros.
 */
export async function getPlayerRating(provider, ratings, pool, player, block = 'latest') {
  return decodePlayer(await provider.callContract(contractCall(ratings, 'player', [poolId(pool), felt(player)]), block));
}

/** An anchor's pinned μ (Q32.32) in `pool`, or null if `player` isn't one there. */
export async function getAnchor(provider, ratings, pool, player, block = 'latest') {
  const r = (await provider.callContract(contractCall(ratings, 'anchor', [poolId(pool), felt(player)]), block)).map(BigInt);
  // Option's Serde: 0 then the value for Some, 1 for None.
  return r[0] === 0n ? signed(r[1]) : null;
}

/** The contract's rules: `{ tag, version, refereeRng }`, to check a rules object against. */
export async function ratingsRules(provider, ratings, block = 'latest') {
  const r = new Reader(await provider.callContract(contractCall(ratings, 'rules'), block));
  const rules = { tag: r.next(), version: r.num(), refereeRng: r.bool() };
  r.done();
  return rules;
}

/** A pool's constants as the contract's rules have them, or null for a pool they lack. */
export async function getPool(provider, ratings, pool, block = 'latest') {
  const r = (await provider.callContract(contractCall(ratings, 'pool', [poolId(pool)]), block)).map(BigInt);
  return r[0] === 0n ? decodePool(r.slice(1)) : null;
}

// ---- Replay: every rating from the contract's events ----
//
// Each rated game emits two `RatingUpdated` events, seat 0's then seat 1's,
// each with the side's state before and after. `verifyRatings` checks both
// things the events allow:
//   - each game on its own: from the two pre-game states and the game's ticket
//     (`TicketUsed`), the update this module computes, under the contract's
//     rule for short games, gives the post-game states, `applied` flags, bands
//     and ranks shown that the events report;
//   - the chain: each side's pre-game state is the player's previous post-game
//     state in the pool, in event order.
// Events must be in chain order, not by `played_at`: a game rated late uses the
// players' states at the time it was rated. Replay from the contract's
// deployment: anchors and rank offsets come from its `PolicySet` events.
//
// Each game replays under the rules of the version its events carry
// (`params`), so events written before a rules upgrade still replay.

const KIND_ANCHOR = tag('anchor'), KIND_OFFSET = tag('offset');
const OFFSET_BIAS = 1n << 31n;
const same = (a, b) => a.mu === b.mu && a.phi === b.phi && a.last === b.last;
const pre = side => ({ mu: side.pre_mu, phi: side.pre_phi, last: side.pre_last });
const post = side => ({ mu: side.mu, phi: side.phi, last: side.last_played });
const within = (map, key, make = () => new Map()) => {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
};

/** Rules by version: a function of `params`, a `{ [params]: rules }` map (or `Map`), or one rules object. */
function resolver(rules) {
  if (typeof rules === 'function') return params => rules(params) ?? null;
  if (rules instanceof Map) return params => rules.get(params) ?? null;
  if (rules && typeof rules.pool === 'function') return params => (params === Number(rules.version) ? rules : null);
  return params => rules?.[params] ?? null;
}

/**
 * Check a sequence of decoded events (`decodeEvent`), in chain order, under
 * `rules` (see `resolver` above). Returns `{ ok, errors, games, players,
 * newcomers, anchors }`, where `errors` lists `{ digest, pool, player, what }`
 * and the rest is per pool (Maps keyed by pool id):
 *   - `players`: pool → player → `{ rating, wins, losses, draws }` replayed;
 *   - `newcomers`: pool → `{ games, expected, won }`, in points: newcomers'
 *     first games against established players, against the prediction. New
 *     players start at fixed band values, so if the pool drifts down,
 *     established players are stronger than their ratings and newcomers score
 *     less than expected; the gap is what the pool's rank offset should add;
 *   - `anchors`: pool → anchor → `{ games, expected, won }`: how each anchor
 *     scores against established players, the signal for re-pinning it.
 */
export function verifyRatings(events, rules) {
  const rulesFor = resolver(rules);
  const tickets = new Map(), voided = new Set(), rated = new Set(), pending = new Map(), errors = [];
  const players = new Map(), pins = new Map(), offsets = new Map(), newcomers = new Map(), anchors = new Map();
  let games = 0;
  const zero = () => ({ rating: { mu: 0n, phi: 0n, last: 0n }, wins: 0, losses: 0, draws: 0 });
  const stateOf = (pool, player) => players.get(pool)?.get(player) ?? zero();
  const fail = (digest, pool, player, what) => errors.push({ digest, pool, player, what });
  // After a game that can't be checked, take its reported states, so the
  // chain checks the games after it.
  const adopt = (pool, sides) => {
    for (const s of sides) {
      if (!s.anchor) within(players, pool).set(s.player, { ...stateOf(pool, s.player), rating: post(s) });
    }
  };

  for (const e of events) {
    if (e.type === 'TicketUsed') {
      if (tickets.has(e.digest)) fail(e.digest, e.pool, null, 'ticket used twice');
      tickets.set(e.digest, e);
    }
    if (e.type === 'GameVoided') voided.add(e.digest);
    if (e.type === 'PolicySet' && e.kind === KIND_ANCHOR) {
      if (e.allowed) within(pins, e.pool).set(e.value, e.extra - BIAS_40);
      else within(pins, e.pool).delete(e.value);
    }
    if (e.type === 'PolicySet' && e.kind === KIND_OFFSET) offsets.set(e.pool, Number(e.value - OFFSET_BIAS));
    if (e.type !== 'RatingUpdated') continue;
    const first = pending.get(e.digest);
    if (!first) { pending.set(e.digest, e); continue; }
    pending.delete(e.digest);
    games++;
    const digest = e.digest, pool = first.pool, sides = [first, e];
    if (rated.has(digest)) fail(digest, pool, null, 'rated twice');
    rated.add(digest);
    if (voided.has(digest)) fail(digest, pool, null, 'rated after it was voided');
    const used = tickets.get(digest);
    if (!used) { fail(digest, pool, null, 'no TicketUsed before its rating'); adopt(pool, sides); continue; }
    const { ticket } = used;
    if (e.pool !== pool || used.pool !== pool || ticket.pool !== pool) {
      fail(digest, pool, null, 'events name another pool than the ticket');
      continue;
    }
    if (first.player !== ticket.player_0 || e.player !== ticket.player_1) {
      fail(digest, pool, null, 'events name other players than the ticket');
      continue;
    }
    // Both sides tell the same game.
    const [score, t, steps] = [first.score, first.played_at, first.steps];
    if (e.score !== 2 - score || e.played_at !== t || e.steps !== steps || e.params !== first.params) {
      fail(digest, pool, null, 'the two sides disagree');
    }
    for (const [s, other] of [[first, e], [e, first]]) {
      if (s.opponent !== other.player || s.channel !== used.channel || s.game_id !== used.game_id
        || s.source !== ticket.source) fail(digest, pool, s.player, 'event fields disagree with the ticket');
    }
    const version = rulesFor(first.params);
    if (!version) { fail(digest, pool, null, `no rules for params ${first.params}`); adopt(pool, sides); continue; }
    if (version.pool(pool) == null) { fail(digest, pool, null, 'the rules have no such pool'); adopt(pool, sides); continue; }
    const p = poolOf(version, pool), poolPins = within(pins, pool);
    const offset = offsets.get(pool) ?? 0;
    // The chain: each pre-game state is the player's last post-game state; an
    // anchor's is its pin.
    const xs = sides.map((side, i) => {
      const band = i ? ticket.band_1 : ticket.band_0, pinned = poolPins.has(side.player);
      const before = pre(side), isNew = before.phi === 0n;
      if (side.anchor !== pinned) fail(digest, pool, side.player, `anchor ${side.anchor}, expected ${pinned}`);
      if (side.anchor) {
        if (pinned && !same(anchorRating(version, pool, poolPins.get(side.player), t), before)) {
          fail(digest, pool, side.player, 'pre-game state is not the anchor\'s pin');
        }
        return { side, band, before, isNew: false, start: before };
      }
      if (!same(stateOf(pool, side.player).rating, before)) {
        fail(digest, pool, side.player, 'pre-game state is not the previous post-game state');
      }
      return { side, band, before, isNew, start: isNew ? start(version, pool, band) : before };
    });
    const missing = xs.find(x => x.start == null);
    if (missing) { fail(digest, pool, missing.side.player, `no start for band ${missing.band}`); adopt(pool, sides); continue; }
    // The game on its own. A short onchain forfeit counts only for the loser;
    // an anchor never changes.
    const short = steps < p.minSteps;
    if (short && score === 1) fail(digest, pool, null, 'a short draw was rated, not voided');
    const apply = [!xs[0].side.anchor && (!short || score === 0), !xs[1].side.anchor && (!short || score === 2)];
    const out = update(version, pool, xs[0].start, xs[1].start, score, t);
    const pa = Number(out.p) / 2 ** 32;
    const established = x => {
      const s = stateOf(pool, x.side.player);
      return !x.side.anchor && s.wins + s.losses + s.draws >= p.settledGames;
    };
    // Drift: a newcomer's first game against an established player.
    if (!short && xs[0].isNew !== xs[1].isNew && established(xs[0].isNew ? xs[1] : xs[0])) {
      const signal = within(newcomers, pool, () => ({ games: 0, expected: 0, won: 0 }));
      const newFirst = xs[0].isNew;
      signal.games++;
      signal.expected += newFirst ? pa : 1 - pa;
      signal.won += (newFirst ? score : 2 - score) / 2;
    }
    // Calibration: an anchor's games against established players.
    for (const [a, o, points, expected] of [[xs[0], xs[1], score, pa], [xs[1], xs[0], 2 - score, 1 - pa]]) {
      if (short || !a.side.anchor || !established(o)) continue;
      const signal = within(within(anchors, pool), a.side.player, () => ({ games: 0, expected: 0, won: 0 }));
      signal.games++;
      signal.expected += expected;
      signal.won += points / 2;
    }
    for (const [i, x, after, points] of [[0, xs[0], out.a, score], [1, xs[1], out.b, 2 - score]]) {
      const { side } = x;
      const end = side.anchor ? x.before : apply[i] ? after : x.isNew ? x.before : age(version, pool, x.before, t);
      if (side.applied !== apply[i]) fail(digest, pool, side.player, `applied ${side.applied}, expected ${apply[i]}`);
      if (!same(end, post(side))) {
        fail(digest, pool, side.player, side.anchor ? 'an anchor\'s state changed' : 'post-game state differs from the update');
      }
      const band = x.isNew && apply[i] ? x.band : 0;
      if (side.band !== band) fail(digest, pool, side.player, `band ${side.band}, expected ${band}`);
      const shown = end.phi !== 0n ? Number(version.shown(pool, end.mu, offset)) : 0;
      if (side.shown !== shown) fail(digest, pool, side.player, `shown ${side.shown}, expected ${shown}`);
      // An anchor isn't stored, nor is a new player the game didn't count for.
      if (side.anchor || (x.isNew && !apply[i])) continue;
      const next = { ...stateOf(pool, side.player), rating: post(side) };
      if (apply[i]) {
        if (points === 0) next.losses++;
        else if (points === 1) next.draws++;
        else next.wins++;
      }
      within(players, pool).set(side.player, next);
    }
  }
  for (const [digest, side] of pending) fail(digest, side.pool, side.player, 'a rating with no opposite side');
  return { ok: errors.length === 0, errors, games, players, newcomers, anchors };
}

const SELECTORS = Object.fromEntries(['RatingUpdated', 'TicketUsed', 'GameVoided', 'PolicySet']
  .map(name => [BigInt(hash.getSelectorFromName(name)), name]));

/**
 * One ratings event from RPC `{ keys, data }`, decoded, or null for another
 * event. The contract embeds `RatingsComponent`'s events `#[flat]`, so the
 * first key is the event's own selector. Signed values (μ) come back as
 * BigInt; `ticketFormat` is the domain tag of the tickets `TicketUsed` carries.
 */
export function decodeEvent({ keys, data }, { ticketFormat = PAIRING_V1 } = {}) {
  const type = SELECTORS[BigInt(keys[0])];
  const k = keys.map(BigInt), d = data.map(BigInt);
  if (type === 'RatingUpdated') {
    const [channel, game_id, opponent, score, source, steps, played_at, params, band, applied,
      pre_mu, pre_phi, pre_last, mu, phi, last_played, shown, anchor] = d;
    return { type, player: k[1], digest: k[2], pool: k[3], channel, game_id, opponent, score: Number(score),
      source: Number(source), steps: Number(steps), played_at, params: Number(params), band: Number(band),
      applied: applied === 1n, pre_mu: signed(pre_mu), pre_phi, pre_last, mu: signed(mu), phi, last_played,
      shown: Number(shown), anchor: anchor === 1n };
  }
  // The whole ticket, as `rateCall` takes it.
  if (type === 'TicketUsed') {
    return { type, digest: k[1], channel: k[2], pool: k[3], game_id: d[0], ticket: decodeTicket(d.slice(1), ticketFormat) };
  }
  if (type === 'GameVoided') return { type, digest: k[1], channel: d[0], game_id: d[1], reason: Number(d[2]) };
  if (type === 'PolicySet') return { type, kind: k[1], pool: k[2], value: d[0], extra: d[1], allowed: d[2] === 1n };
  return null;
}

/** Every ratings event at `address` from `fromBlock`, decoded, in chain order. */
export async function fetchRatingEvents(provider, address, fromBlock = 0, options = {}) {
  const events = [];
  let continuation_token;
  do {
    const page = await provider.getEvents({ address, from_block: { block_number: fromBlock }, to_block: 'latest',
      chunk_size: 1000, continuation_token });
    for (const event of page.events) {
      const decoded = decodeEvent(event, options);
      if (decoded) events.push({ ...decoded, block: event.block_number, tx: event.transaction_hash });
    }
    continuation_token = page.continuation_token;
  } while (continuation_token);
  return events;
}
