// @arbiter/sdk/ratings: the integer update, tickets, calls, event decoding and
// the replay, under the tests' rules (`TEST_RULES`, the mirror of
// ratings/src/tests/rules.cairo). Bit for bit against the Cairo is
// ratings/src/tests/test_vectors.cairo, from sdk/scripts/gen-rating-vectors.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash } from 'starknet';
import { hex, poseidon, publicKey, signingHash, standardTime, tag, verify } from '../src/index.mjs';
import * as r from '../src/ratings.mjs';
import { BLITZ, POOL_CASES, RAPID, SDK_RATINGS, SDK_SETTINGS, SDK_TICKET, TEST_RULES, testPool } from './rating-rules.mjs';

const { ONE } = r;
const q = x => Number(x) / Number(ONE);
const T0 = 1_700_000_000n;
const DAY = 86400n;
const at = (mu, phi, last) => ({ mu, phi, last });
const PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
/** The digest ratings/src/tests/test_vectors.cairo checks (`digest_matches_the_sdk`). */
const SDK_DIGEST = 0x1c7b4ca4e675e9bbe2a54e87c13a20aafcf51620cc10a8ed186c22d29bf331en;

// Deterministic pseudo-random numbers (xorshift32).
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
}

// ---- Primitives ----

test('division rounds half to even, symmetric in sign', () => {
  assert.deepEqual([5n, 7n, 3n, 1n, 9n].map(n => r.div(n, 2n)), [2n, 4n, 2n, 0n, 4n]);
  assert.deepEqual([-5n, -7n, -3n].map(n => r.div(n, 2n)), [-2n, -4n, -2n]);
  assert.equal(r.div(10n, 3n), 3n);
  assert.equal(r.div(11n, 3n), 4n);
  assert.throws(() => r.div(1n, 0n));
});

test('quot floors, and refuses what Cairo refuses', () => {
  assert.deepEqual([r.quot(7n, 2n), r.quot(0n, 5n), r.quot(9n, 10n)], [3n, 0n, 0n]);
  assert.throws(() => r.quot(-1n, 2n));
  assert.throws(() => r.quot(1n, 0n));
  assert.throws(() => r.expNeg(-1n));
});

test('square roots round to nearest', () => {
  const next = rng(7);
  for (let i = 0; i < 2000; i++) {
    const n = BigInt(Math.floor(next() * 2 ** 50)) * BigInt(1 + Math.floor(next() * 2 ** 40));
    const s = r.sqrt(n);
    assert.ok(n > s * s - s && n <= s * s + s, `${n}`); // (s − ½)² < n ≤ (s + ½)²
  }
  assert.deepEqual([0n, 1n, 2n, 3n, 4n, 6n, 7n, -4n].map(r.sqrt), [0n, 1n, 1n, 2n, 2n, 2n, 3n, 0n]);
});

test('e^(-x) is within two units of the last place, and the sigmoid is symmetric', () => {
  for (let x = 0; x < 30; x += 0.013) {
    const got = r.expNeg(BigInt(Math.round(x * Number(ONE))));
    assert.ok(Math.abs(Number(got) - Math.exp(-x) * Number(ONE)) <= 2, `x=${x}`);
  }
  assert.equal(r.expNeg(0n), ONE);
  assert.equal(r.expNeg(23n * ONE), 0n);
  assert.equal(r.sigmoid(0n), ONE / 2n);
  for (let z = -20; z <= 20; z += 0.37) {
    const x = BigInt(Math.round(z * Number(ONE)));
    const sum = r.sigmoid(x) + r.sigmoid(-x);
    assert.ok(sum >= ONE - 1n && sum <= ONE + 1n, `z=${z}`);
    assert.ok(Math.abs(q(r.sigmoid(x)) - 1 / (1 + Math.exp(-z))) < 1e-9);
  }
});

test('the drift is 1.15·2·ln 2 per half-life, as Surround computes it', () => {
  // Surround's `CNUM_ONE`: 6847202285·2^32.
  assert.equal(r.C_HALF_LIFE, 6847202285n * ONE);
  for (const days of [15n, 30n, 45n, 60n]) {
    assert.ok(Math.abs(q(r.driftOf(days * ONE)) - 1.15 * 2 * Math.LN2 / Number(days)) < 1e-9);
  }
  assert.equal(r.driftOf(30n * ONE), r.div(r.C_HALF_LIFE, 30n * ONE));
});

// ---- Elo display ----

/** μ whose Elo value before rounding is exactly k + ½, on either side of 0. */
function eloTies() {
  const ties = [];
  for (let k = -1800n; k <= 1800n; k++) {
    const inner = k * ONE + ONE / 2n;
    const guess = inner * ONE / r.ELO_SCALE;
    for (const mu of [guess - 1n, guess, guess + 1n]) {
      if (r.div(r.ELO_SCALE * mu, ONE) === inner) ties.push(mu);
    }
  }
  return ties;
}

test('elo is 1500 + 173.7178·μ, rounded half to even', () => {
  assert.equal(r.elo(0n), 1500);
  assert.equal(r.elo(ONE), 1674);
  assert.equal(r.elo(-ONE), 1326);
  assert.ok(Math.abs(q(r.ELO_SCALE) - 400 / Math.LN10) < 1e-9);
  for (const band of [1, 2, 3, 4, 5, 7]) {
    assert.equal(r.elo(r.start(TEST_RULES, BLITZ, band).mu), [0, 800, 1200, 1500, 1800, 2100, 0, 2400][band]);
  }
  const ties = eloTies();
  let even = 0, odd = 0;
  for (const mu of ties) {
    const total = 1500n * ONE + r.div(r.ELO_SCALE * mu, ONE);
    if (total < 0n) continue;
    const floor = total / ONE;
    assert.equal(BigInt(r.elo(mu)), floor % 2n === 0n ? floor : floor + 1n, `μ ${mu}`);
    if (floor % 2n === 0n) even++; else odd++;
  }
  assert.ok(even > 0 && odd > 0, `${even} ties round down, ${odd} up`);
});

test('elo adds the offset before holding to 0..65535', () => {
  assert.equal(r.elo(0n, 25), 1525);
  assert.equal(r.elo(0n, -1500), 0);
  assert.equal(r.elo(0n, -1501), 0);
  assert.equal(r.elo(0n, 64035), 65535);
  assert.equal(r.elo(0n, 64036), 65535);
  assert.equal(r.elo(-10n * ONE), 0);
  assert.equal(r.elo(-10n * ONE, 300), 63);
  assert.equal(r.elo(400n * ONE), 65535);
  assert.equal(r.elo(400n * ONE, -2147483648), 0);
});

// ---- Pools and rules ----

test('validPool holds each bound of the packed state', () => {
  for (const [label, change, expected] of POOL_CASES) {
    assert.equal(r.validPool({ ...testPool(), ...change }), expected, label);
  }
});

test('TEST_RULES: two valid pools, bands 1 to 7 but 6, a drift per pool', () => {
  assert.ok(r.validPool(TEST_RULES.pool(BLITZ)) && r.validPool(TEST_RULES.pool(RAPID)));
  assert.equal(TEST_RULES.pool(tag('bullet')), null);
  assert.deepEqual(r.poolOf(TEST_RULES, 'blitz'), testPool());
  assert.throws(() => r.poolOf(TEST_RULES, 'bullet'), /Unknown pool/);
  assert.throws(() => r.update(TEST_RULES, 'bullet', r.start(TEST_RULES, 'blitz', 3), r.start(TEST_RULES, 'blitz', 3), 2, T0));
  assert.deepEqual([0, 6, 8].map(b => r.start(TEST_RULES, BLITZ, b)), [null, null, null]);
  assert.deepEqual(r.start(TEST_RULES, 'rapid', 3), { mu: 0n, phi: 0n, last: 0n });
  assert.ok(TEST_RULES.drift(BLITZ, 0n) > TEST_RULES.drift(RAPID, 0n));
});

// ---- The update ----

/** The same model in floating point, with the test rules' flat drift. */
function updateF(pool, a, b, result, t) {
  const halfLife = pool === BLITZ ? 30 : 60, p = testPool();
  const aged = x => {
    if (x.phi === 0) return 4;
    const dt = Math.min(t - x.last, 2 ** 30);
    if (dt <= 0) return x.phi ** 2;
    const c = 1.15 * 2 * Math.LN2 / halfLife;
    return Math.min(4, x.phi ** 2 + c * c * dt / 86400);
  };
  const g = v => 1 / Math.sqrt(1 + 3 * v / Math.PI ** 2);
  const sig = z => 1 / (1 + Math.exp(-z));
  const va = aged(a), vb = aged(b);
  const side = (x, v, gg, oppMu, s) => {
    const E = sig(gg * (x.mu - oppMu));
    const v2 = 1 / (1 / v + gg * gg * E * (1 - E));
    const mu = Math.min(q(p.muMax), Math.max(q(p.muMin), x.mu + v2 * gg * (s - E)));
    return { mu, phi: Math.max(q(p.minPhi), Math.sqrt(v2)), last: Math.max(x.last, t) };
  };
  return { p: sig(g(va + vb) * (a.mu - b.mu)), a: side(a, va, g(vb), b.mu, result / 2), b: side(b, vb, g(va), a.mu, 1 - result / 2) };
}

test('matches the floating-point model over random games in both pools', () => {
  const next = rng(42);
  let maxP = 0, maxMu = 0, maxPhi = 0;
  const bands = [1, 2, 3, 4, 5, 7];
  const players = { [BLITZ]: [], [RAPID]: [] };
  for (const pool of [BLITZ, RAPID]) {
    for (let i = 0; i < 30; i++) players[pool].push(r.start(TEST_RULES, pool, bands[i % 6]));
  }
  let t = T0;
  for (let i = 0; i < 3000; i++) {
    const pool = next() < 0.5 ? BLITZ : RAPID, list = players[pool];
    const a = Math.floor(next() * 30), b = (a + 1 + Math.floor(next() * 29)) % 30;
    t += BigInt(Math.floor(next() ** 4 * 90 * 86400));
    const result = next() < 0.02 ? 1 : next() < 0.5 ? 2 : 0;
    const f = updateF(pool, ...[list[a], list[b]].map(x => ({ mu: q(x.mu), phi: q(x.phi), last: Number(x.last) })),
      result, Number(t));
    const out = r.update(TEST_RULES, pool, list[a], list[b], result, t);
    maxP = Math.max(maxP, Math.abs(q(out.p) - f.p));
    for (const [x, y] of [[out.a, f.a], [out.b, f.b]]) {
      maxMu = Math.max(maxMu, Math.abs(q(x.mu) - y.mu));
      maxPhi = Math.max(maxPhi, Math.abs(q(x.phi) - y.phi));
    }
    list[a] = out.a; list[b] = out.b;
  }
  assert.ok(maxP < 1e-8, `p ${maxP}`);
  assert.ok(maxMu < 1e-7, `mu ${maxMu}`);
  assert.ok(maxPhi < 1e-7, `phi ${maxPhi}`);
});

test('winners gain, losers lose, draws pull together', () => {
  const a = at(-ONE, ONE / 2n, 1000n), b = at(ONE, ONE / 2n, 1000n);
  const won = r.update(TEST_RULES, BLITZ, a, b, 2, 2000n);
  assert.ok(won.a.mu > a.mu && won.b.mu < b.mu);
  const lost = r.update(TEST_RULES, BLITZ, a, b, 0, 2000n);
  assert.ok(lost.a.mu < a.mu && lost.b.mu > b.mu);
  const drew = r.update(TEST_RULES, BLITZ, a, b, 1, 2000n);
  assert.ok(drew.a.mu > a.mu && drew.b.mu < b.mu); // the weaker player gains
  assert.ok(won.p < ONE / 2n);
  // Cairo's `match result { 0, 1, _ }`: anything above 2 is seat 0's win.
  assert.deepEqual(r.update(TEST_RULES, BLITZ, a, b, 3, 2000n), won);
  // Numbers or BigInts, pool ids as strings or felts.
  assert.deepEqual(r.update(TEST_RULES, 'blitz', { mu: -ONE, phi: ONE / 2n, last: 1000 }, b, 2n, 2000), won);
});

test('ratings stay in range and clocks never go back', () => {
  const p = testPool();
  const top = at(p.muMax, p.phi0, 5000n), bottom = at(p.muMin, p.phi0, 5000n);
  const upset = r.update(TEST_RULES, RAPID, bottom, top, 2, 4000n); // rated late: t before both last-played times
  assert.ok(upset.a.mu <= p.muMax && upset.b.mu >= p.muMin);
  assert.equal(upset.a.last, 5000n);
  const expected = r.update(TEST_RULES, RAPID, top, bottom, 2, 6000n);
  assert.equal(expected.a.mu, p.muMax);
  assert.equal(expected.b.mu, p.muMin);
  const idle = r.update(TEST_RULES, RAPID, at(0n, p.minPhi, 0n), at(0n, p.minPhi, 0n), 2, 1n << 62n);
  assert.ok(idle.a.phi <= p.phi0);
  const settledPair = r.update(TEST_RULES, RAPID, at(0n, p.minPhi, T0), at(0n, p.minPhi, T0), 1, T0);
  assert.equal(settledPair.a.phi, p.minPhi);
});

test('a new player brings φ0, whatever its clock says', () => {
  const fresh = r.start(TEST_RULES, BLITZ, 3);
  const asIf = r.update(TEST_RULES, BLITZ, fresh, at(ONE, ONE / 2n, T0), 2, T0);
  const atPhi0 = r.update(TEST_RULES, BLITZ, at(0n, 2n * ONE, T0), at(ONE, ONE / 2n, T0), 2, T0);
  assert.deepEqual(asIf, atPhi0);
  assert.equal(r.agedPhi(TEST_RULES, BLITZ, fresh, T0), 2n * ONE);
});

test('updateStates is update without p', () => {
  const next = rng(3);
  for (let i = 0; i < 200; i++) {
    const a = at(BigInt(Math.floor((next() - 0.5) * 2 ** 36)), BigInt(1 + Math.floor(next() * 2 ** 33)), T0 - BigInt(Math.floor(next() * 1e7)));
    const b = at(BigInt(Math.floor((next() - 0.5) * 2 ** 36)), BigInt(1 + Math.floor(next() * 2 ** 33)), T0 - BigInt(Math.floor(next() * 1e7)));
    const pool = i % 2 ? BLITZ : RAPID, result = i % 3;
    const { a: na, b: nb } = r.update(TEST_RULES, pool, a, b, result, T0);
    assert.deepEqual(r.updateStates(TEST_RULES, pool, a, b, result, T0), { a: na, b: nb });
  }
});

test('aging grows φ by the pool\'s drift, up to φ0, and moves the clock forward', () => {
  const x = at(ONE, ONE / 2n, T0);
  assert.equal(r.agedPhi(TEST_RULES, BLITZ, x, T0), ONE / 2n);
  assert.equal(r.agedPhi(TEST_RULES, BLITZ, x, T0 - DAY), ONE / 2n);
  const blitz = r.agedPhi(TEST_RULES, BLITZ, x, T0 + 30n * DAY), rapid = r.agedPhi(TEST_RULES, RAPID, x, T0 + 30n * DAY);
  assert.ok(blitz > rapid && rapid > ONE / 2n);
  const c = q(r.driftOf(30n * ONE));
  assert.ok(Math.abs(q(blitz) - Math.sqrt(0.25 + c * c * 30)) < 1e-8);
  assert.ok(r.agedPhi(TEST_RULES, RAPID, x, T0 + 3650n * DAY) < 2n * ONE);
  assert.equal(r.agedPhi(TEST_RULES, RAPID, x, T0 + 7300n * DAY), 2n * ONE);
  assert.deepEqual(r.age(TEST_RULES, BLITZ, x, T0 + 30n * DAY), at(ONE, blitz, T0 + 30n * DAY));
  assert.deepEqual(r.age(TEST_RULES, BLITZ, at(ONE, ONE / 2n, T0 + 100n), T0), at(ONE, ONE / 2n, T0 + 100n));
});

test('settled needs the pool\'s games and an aged φ of at most 1.0; provisional needs a win and a loss', () => {
  const p = testPool(), x = at(0n, ONE, T0);
  assert.equal(r.settled(TEST_RULES, BLITZ, x, p.settledGames, T0), true);
  assert.equal(r.settled(TEST_RULES, BLITZ, x, p.settledGames - 1, T0), false);
  assert.equal(r.settled(TEST_RULES, BLITZ, x, p.settledGames, T0 + 1n), false); // aged past 1.0
  assert.equal(r.provisional(p, ONE, 1, 1), false);
  assert.equal(r.provisional(p, ONE + 1n, 1, 1), true);
  assert.equal(r.provisional(p, ONE / 2n, 3, 0), true);
  assert.equal(r.provisional(p, ONE / 2n, 0, 3), true);
  assert.deepEqual(r.anchorRating(TEST_RULES, RAPID, -ONE, T0), at(-ONE, ONE / 4n, T0));
});

// ---- Tickets ----

test('a ticket is its Serde fields, in order, and decodes back', () => {
  const fields = r.ticketFields(SDK_TICKET);
  assert.equal(fields.length, 17);
  assert.deepEqual(fields, [tag('SN_SEPOLIA'), 0x111n, 0x222n, 0x333n, BLITZ, 0xc0f1925n, 0x444n, SDK_TICKET.clock, 0x555n,
    600n, 1n, 3n, 7n, 0x666n, 1_700_000_000n, 1_700_000_300n, 7n]);
  assert.deepEqual(r.ticketFields({ ...SDK_TICKET, pool: 'blitz' }), fields);
  assert.deepEqual(r.decodeTicket(fields), SDK_TICKET);
  assert.deepEqual(r.decodeTicket(fields.map(hex)), SDK_TICKET);
  assert.throws(() => r.decodeTicket(fields.slice(1)), /Truncated/);
  assert.throws(() => r.decodeTicket([...fields, 0n]), /Trailing/);
  assert.throws(() => r.ticketFields(SDK_TICKET, 'ARBITER_PAIRING_V0'), /Unknown ticket format/);
  assert.deepEqual(r.TICKET_FORMATS[r.PAIRING_V1], Object.keys(SDK_TICKET));
});

test('the ticket digest binds the game, the ratings contract and every field', () => {
  const digest = r.ticketDigest(SDK_TICKET, 'TEST', SDK_RATINGS);
  assert.equal(digest, SDK_DIGEST);
  assert.equal(digest, signingHash([tag('ARBITER_PAIRING_V1'), tag('TEST'), SDK_RATINGS, ...r.ticketFields(SDK_TICKET)]));
  assert.ok(digest < 1n << 250n);
  assert.equal(r.ticketDigest(SDK_TICKET, tag('TEST'), SDK_RATINGS), digest);
  assert.equal(r.ticketDigest({ ...SDK_TICKET }, TEST_RULES.tag, hex(SDK_RATINGS)), digest);
  assert.notEqual(r.ticketDigest(SDK_TICKET, 'SURROUND', SDK_RATINGS), digest);
  assert.notEqual(r.ticketDigest(SDK_TICKET, 'TEST', SDK_RATINGS + 1n), digest);
  const seen = new Set([digest]);
  for (const k of Object.keys(SDK_TICKET)) {
    const changed = { ...SDK_TICKET, [k]: typeof SDK_TICKET[k] === 'number' ? SDK_TICKET[k] + 1 : SDK_TICKET[k] + 1n };
    seen.add(r.ticketDigest(changed, 'TEST', SDK_RATINGS));
  }
  assert.equal(seen.size, 18);
});

test('the matchmaker signs the digest', () => {
  const key = 0x3a7c4n;
  const signature = r.signTicket(SDK_TICKET, 'TEST', SDK_RATINGS, key);
  assert.ok(verify(SDK_DIGEST, signature, publicKey(key)));
  assert.ok(!verify(r.ticketDigest({ ...SDK_TICKET, band_1: 5 }, 'TEST', SDK_RATINGS), signature, publicKey(key)));
  assert.ok(!verify(r.ticketDigest(SDK_TICKET, 'TEST', 0x1n), signature, publicKey(key)));
});

test('config and clock hashes', () => {
  const config = [20n, 0n];
  assert.equal(r.configHash('TEST', config), poseidon([tag('TEST'), tag('ARBITER_CONFIG_V1'), 20n, 0n]));
  assert.equal(r.configHash(tag('TEST'), config), r.configHash('TEST', config));
  assert.notEqual(r.configHash('OTHER', config), r.configHash('TEST', config));
  const settings = standardTime.encodeSettings(SDK_SETTINGS);
  assert.deepEqual(settings, [30000n, 180000n, 2000n, 1n]);
  // The settings' felts as `set_clock_preset` takes them, without their length.
  assert.equal(r.clockHash(settings), poseidon(settings));
  assert.equal(SDK_TICKET.clock, r.clockHash(settings));
  assert.notEqual(r.clockHash(standardTime.encodeSettings({ ...SDK_SETTINGS, increment_ms: 0 })), SDK_TICKET.clock);
});

// ---- Calls and reads ----

test('rateCall is the channel\'s rate(game_id, ticket)', () => {
  const call = r.rateCall(0xc4a11e1n, 0x9a3en, SDK_TICKET);
  assert.deepEqual(call, { contractAddress: '0xc4a11e1', entrypoint: 'rate',
    calldata: [0x9a3en, ...r.ticketFields(SDK_TICKET)].map(hex) });
  assert.equal(r.rateCall(0xc4a11e1n, 1n, SDK_TICKET, 'rate_game').entrypoint, 'rate_game');
});

/** A provider that answers `callContract` from a table by entrypoint, recording the calls. */
function fakeProvider(answers) {
  const calls = [];
  return { calls, async callContract(call, block) { calls.push({ ...call, block }); return answers[call.entrypoint].map(hex); } };
}
const neg = x => PRIME + x;

test('reads decode a player, an anchor, the rules and a pool', async () => {
  const player = [neg(-ONE), ONE / 2n, T0, 12n, 7n, 4n, 1n, 1326n, 0n, 1n, 1n, neg(-2n * ONE), 1n, 3n, 1n, 0n];
  const p = testPool();
  const pool = [0n, p.phi0, p.minPhi, neg(p.muMin), p.muMax, p.provisionalPhi, 10n, 4n, p.anchorPhi, neg(p.anchorMuMin),
    p.anchorMuMax, 400n];
  const provider = fakeProvider({ player, anchor: [0n, neg(-3n * ONE)], rules: [tag('TEST'), 1n, 0n], pool });
  assert.deepEqual(await r.getPlayerRating(provider, 0x7a71e5n, 'blitz', 0x222n), {
    mu: -ONE, phi: ONE / 2n, last_played: T0, games: 12, wins: 7, losses: 4, draws: 1, shown: 1326, provisional: false,
    established: true, settled: true, peak: -2n * ONE, has_peak: true, band: 3, params: 1, anchor: false });
  assert.deepEqual(provider.calls[0], { contractAddress: '0x7a71e5', entrypoint: 'player', calldata: [hex(BLITZ), '0x222'], block: 'latest' });
  assert.equal(await r.getAnchor(provider, 0x7a71e5n, RAPID, 0x7n, 123), -3n * ONE);
  assert.deepEqual(provider.calls[1].calldata, [hex(RAPID), '0x7']);
  assert.equal(provider.calls[1].block, 123);
  assert.equal(await r.getAnchor(fakeProvider({ anchor: [1n] }), 0x7a71e5n, RAPID, 0x7n), null);
  assert.deepEqual(await r.ratingsRules(provider, 0x7a71e5n), { tag: tag('TEST'), version: 1, refereeRng: false });
  assert.deepEqual(await r.getPool(provider, 0x7a71e5n, 'blitz'), testPool());
  assert.equal(await r.getPool(fakeProvider({ pool: [1n] }), 0x7a71e5n, 'bullet'), null);
  assert.throws(() => r.decodePlayer(player.slice(1)), /Truncated/);
});

// ---- Events ----

const CHANNEL = 0xc4a11e1n;
const SEL = name => BigInt(hash.getSelectorFromName(name));
const felt = x => (BigInt(x) < 0n ? PRIME + BigInt(x) : BigInt(x));
const flag = x => (x ? 1n : 0n);

/** A decoded event as the RPC returns it: `{ keys, data }` in hex. */
function raw(e) {
  const encode = (keys, data) => ({ keys: keys.map(felt).map(hex), data: data.map(felt).map(hex) });
  switch (e.type) {
    case 'RatingUpdated':
      return encode([SEL(e.type), e.player, e.digest, e.pool], [e.channel, e.game_id, e.opponent, e.score, e.source,
        e.steps, e.played_at, e.params, e.band, flag(e.applied), e.pre_mu, e.pre_phi, e.pre_last, e.mu, e.phi,
        e.last_played, e.shown, flag(e.anchor)]);
    case 'TicketUsed': return encode([SEL(e.type), e.digest, e.channel, e.pool], [e.game_id, ...r.ticketFields(e.ticket)]);
    case 'GameVoided': return encode([SEL(e.type), e.digest], [e.channel, e.game_id, e.reason]);
    case 'PolicySet': return encode([SEL(e.type), e.kind, e.pool], [e.value, e.extra, flag(e.allowed)]);
    default: throw Error(e.type);
  }
}

const ZERO = at(0n, 0n, 0n);
const key = (pool, player) => `${pool}:${player}`;

/**
 * A model of `RatingsComponent::rate_game` with its policy: the events it
 * emits for each game, as `decodeEvent` returns them.
 */
function contract() {
  const state = new Map(), pins = new Map(), offsets = new Map(), events = [];
  let n = 0;
  const policy = (kind, pool, value, extra, allowed) => events.push({ type: 'PolicySet', kind: tag(kind), pool, value, extra, allowed });
  return {
    events,
    pin(pool, player, mu) { pins.set(key(pool, player), mu); policy('anchor', pool, player, mu + r.BIAS_40, true); },
    unpin(pool, player) { pins.delete(key(pool, player)); policy('anchor', pool, player, 0n, false); },
    offset(pool, offset) { offsets.set(pool, offset); policy('offset', pool, BigInt(offset) + (1n << 31n), 0n, true); },
    void(pool, p0, p1, { bands = [2, 2], reason = r.VOID_SHORT } = {}) {
      const digest = this.ticket(pool, p0, p1, bands, r.QUEUE);
      events.push({ type: 'GameVoided', digest, channel: CHANNEL, game_id: digest, reason });
      return digest;
    },
    ticket(pool, p0, p1, bands, source) {
      const digest = BigInt(++n) * 0x10001n;
      const ticket = { ...SDK_TICKET, channel: CHANNEL, player_0: p0, player_1: p1, pool, band_0: bands[0],
        band_1: bands[1], source, nonce: digest };
      events.push({ type: 'TicketUsed', digest, channel: CHANNEL, pool, game_id: digest, ticket });
      return digest;
    },
    rate(pool, p0, p1, score, { t, steps = 60, bands = [2, 2], source = r.QUEUE, rules = TEST_RULES } = {}) {
      const digest = this.ticket(pool, p0, p1, bands, source);
      const p = r.poolOf(rules, pool);
      const sides = [p0, p1].map((player, i) => {
        if (pins.has(key(pool, player))) {
          const pin = r.anchorRating(rules, pool, pins.get(key(pool, player)), t);
          return { player, anchor: true, before: pin, start: pin, isNew: false };
        }
        const s = state.get(key(pool, player)) ?? { rating: ZERO, games: 0 };
        const isNew = s.rating.phi === 0n;
        return { player, anchor: false, before: s.rating, isNew, games: s.games,
          start: isNew ? r.start(rules, pool, bands[i]) : s.rating };
      });
      const short = steps < p.minSteps;
      const apply = [!sides[0].anchor && (!short || score === 0), !sides[1].anchor && (!short || score === 2)];
      const out = r.updateStates(rules, pool, sides[0].start, sides[1].start, score, t);
      [out.a, out.b].forEach((after, i) => {
        const x = sides[i];
        const end = x.anchor ? x.before : apply[i] ? after : x.isNew ? x.before : r.age(rules, pool, x.before, t);
        if (!x.anchor) state.set(key(pool, x.player), { rating: end, games: x.games + (apply[i] ? 1 : 0) });
        events.push({ type: 'RatingUpdated', player: x.player, digest, pool, channel: CHANNEL, game_id: digest,
          opponent: sides[1 - i].player, score: i ? 2 - score : score, source, steps, played_at: t,
          params: rules.version, band: x.isNew && apply[i] ? bands[i] : 0, applied: apply[i], pre_mu: x.before.mu,
          pre_phi: x.before.phi, pre_last: x.before.last, mu: end.mu, phi: end.phi, last_played: end.last,
          shown: end.phi !== 0n ? rules.shown(pool, end.mu, offsets.get(pool) ?? 0) : 0, anchor: x.anchor });
      });
      return digest;
    },
  };
}

/** A season in both pools: three players settle in blitz, then meet a newcomer; rapid runs beside it. */
function season() {
  const c = contract();
  let t = T0;
  c.offset(BLITZ, 25);
  for (let i = 0; i < 24; i++) c.rate(BLITZ, 1n + BigInt(i % 3), 1n + BigInt((i + 1) % 3), i % 2 ? 2 : 0, { t: (t += 3600n) });
  // The same players are new in rapid, from other bands.
  for (let i = 0; i < 6; i++) c.rate(RAPID, 1n + BigInt(i % 2), 3n, i % 3 ? 2 : 1, { t: (t += 600n), bands: [5, 7] });
  c.rate(BLITZ, 1n, 9n, 2, { t: (t += 3600n), bands: [2, 1] }); // a settled player beats a newcomer
  c.void(BLITZ, 2n, 3n);
  c.rate(BLITZ, 2n, 3n, 0, { t: (t += 3600n), steps: 3 }); // a short onchain forfeit: only seat 0 loses
  c.offset(BLITZ, -40);
  c.rate(BLITZ, 4n, 5n, 1, { t: (t += 86400n * 400n), bands: [1, 7] });
  c.rate(RAPID, 9n, 3n, 2, { t: (t += 86400n), bands: [4, 0], steps: 2 }); // a new winner of a short forfeit stays unrated
  return c.events;
}

/** An anchor pinned in rapid, met by a newcomer and by players settled on each other. */
function anchored() {
  const c = contract();
  c.pin(RAPID, 7n, ONE);
  let t = T0;
  for (let i = 0; i < 24; i++) c.rate(RAPID, 1n + BigInt(i % 2), 2n - BigInt(i % 2), i % 2 ? 2 : 0, { t: (t += 3600n) });
  c.rate(RAPID, 9n, 7n, 0, { t: (t += 3600n), bands: [3, 0] });
  c.rate(RAPID, 7n, 1n, 2, { t: (t += 3600n), bands: [0, 2] });
  c.rate(RAPID, 2n, 7n, 2, { t: (t += 86400n * 400n), bands: [2, 0] });
  // Not an anchor in blitz.
  c.rate(BLITZ, 7n, 1n, 2, { t: (t += 3600n), bands: [3, 3] });
  return c.events;
}

test('decodeEvent reads each event as the contract emits it', () => {
  const events = [...season(), ...anchored()];
  for (const e of events) assert.deepEqual(r.decodeEvent(raw(e)), e, e.type);
  assert.equal(r.decodeEvent({ keys: [hex(SEL('Sealed'))], data: [] }), null);
  const used = events.find(e => e.type === 'TicketUsed');
  assert.throws(() => r.decodeEvent(raw(used), { ticketFormat: 'ARBITER_PAIRING_V0' }), /Unknown ticket format/);
});

test('fetchRatingEvents pages through getEvents, keeping block and transaction', async () => {
  const events = season().slice(0, 6), pages = [events.slice(0, 4), events.slice(4)];
  const requests = [];
  const provider = {
    async getEvents(filter) {
      requests.push(filter);
      const i = filter.continuation_token ? 1 : 0;
      return { events: pages[i].map((e, j) => ({ ...raw(e), block_number: 10 + i, transaction_hash: `0x${i}${j}` })),
        continuation_token: i ? undefined : 'next' };
    },
  };
  const fetched = await r.fetchRatingEvents(provider, '0x7a71e5', 5);
  assert.equal(fetched.length, 6);
  assert.deepEqual(fetched.map(({ block, tx, ...e }) => e), events);
  assert.deepEqual([fetched[0].block, fetched[5].block, fetched[5].tx], [10, 11, '0x11']);
  assert.deepEqual(requests[0].from_block, { block_number: 5 });
  assert.equal(requests[1].continuation_token, 'next');
});

// ---- Replay ----

const replay = (events, rules = TEST_RULES) => r.verifyRatings(events.map(raw).map(e => r.decodeEvent(e)), rules);

test('a season in two pools replays', () => {
  const { ok, errors, games, players, newcomers } = replay(season());
  assert.deepEqual(errors, []);
  assert.ok(ok);
  assert.equal(games, 34);
  assert.equal(players.get(BLITZ).size, 6);
  assert.equal(players.get(RAPID).size, 3); // the short forfeit's new winner stays unrated
  // Each pool keeps its own record: player 1 has 16 blitz games, 3 rapid.
  const games1 = s => s.wins + s.losses + s.draws;
  assert.equal(games1(players.get(BLITZ).get(1n)), 17);
  assert.equal(games1(players.get(RAPID).get(1n)), 3);
  assert.equal(players.get(RAPID).get(9n), undefined);
  // Player 9's first game, lost to player 1, settled in blitz.
  const drift = newcomers.get(BLITZ);
  assert.deepEqual([drift.games, drift.won], [1, 0]);
  assert.ok(drift.expected > 0 && drift.expected < 1);
  assert.equal(newcomers.get(RAPID), undefined);
});

test('anchored games replay, and report how each anchor scores against established players', () => {
  const { ok, errors, games, players, anchors } = replay(anchored());
  assert.deepEqual(errors, []);
  assert.ok(ok);
  assert.equal(games, 28);
  assert.equal(players.get(RAPID).has(7n), false);
  assert.equal(players.get(BLITZ).has(7n), true);
  // Two of its three games were against established players: it won one, lost one.
  const signal = anchors.get(RAPID).get(7n);
  assert.deepEqual([signal.games, signal.won], [2, 1]);
  assert.ok(signal.expected > 0 && signal.expected < 2);
});

/** Replay `events` with one RatingUpdated changed, and return the errors' texts. */
function tampered(events, find, change) {
  const i = events.findIndex(e => e.type === 'RatingUpdated' && find(e));
  assert.ok(i >= 0);
  events[i] = { ...events[i], ...change(events[i]) };
  return replay(events).errors.map(e => e.what);
}

test('a changed update, a broken chain or a wrong flag is caught', () => {
  assert.match(tampered(season(), e => e.player === 9n, e => ({ mu: e.mu + 1n })).join(), /post-game state differs/);
  const events = season();
  const last = events.findLastIndex(e => e.type === 'RatingUpdated' && e.player === 1n && e.pool === BLITZ);
  events[last] = { ...events[last], pre_phi: events[last].pre_phi + 1n };
  assert.match(replay(events).errors.map(e => e.what).join(), /previous post-game state/);
  // The short forfeit's winner reported as gaining.
  const short = e => e.steps === 3 && e.score === 2;
  assert.match(tampered(season(), short, () => ({ applied: true })).join(), /applied true, expected false/);
  // A band reported on a player's second game, a rank shown without the offset.
  assert.match(tampered(season(), e => e.player === 9n, () => ({ band: 0 })).join(), /band 0, expected 1/);
  assert.match(tampered(season(), e => e.player === 4n, e => ({ shown: e.shown + 40 })).join(), /shown/);
  // The sides of one game disagree, or name the wrong opponent.
  assert.match(tampered(season(), e => e.player === 5n, e => ({ score: e.score + 1 })).join(), /disagree/);
  assert.match(tampered(season(), e => e.player === 5n, () => ({ opponent: 6n })).join(), /disagree with the ticket/);
});

test('a short draw, a rating without its ticket or its other side, and a voided game rated are caught', () => {
  const draw = contract();
  draw.rate(BLITZ, 1n, 2n, 1, { t: T0, steps: 1 });
  assert.match(replay(draw.events).errors.map(e => e.what).join(), /short draw/);
  const events = season().filter(e => !(e.type === 'TicketUsed' && e.digest === 3n * 0x10001n));
  assert.match(replay(events).errors.map(e => e.what).join(), /no TicketUsed/);
  const cut = season();
  cut.pop();
  assert.match(replay(cut).errors.map(e => e.what).join(), /no opposite side/);
  const voided = season();
  const i = voided.findIndex(e => e.type === 'GameVoided');
  voided.splice(i, 1);
  const rated = voided.findIndex(e => e.type === 'RatingUpdated');
  voided.splice(rated, 0, { type: 'GameVoided', digest: voided[rated].digest, channel: CHANNEL, game_id: voided[rated].digest, reason: 1 });
  assert.match(replay(voided).errors.map(e => e.what).join(), /rated after it was voided/);
});

test('a game told in another pool than its ticket is caught', () => {
  const events = season();
  const used = events.findIndex(e => e.type === 'TicketUsed');
  events[used] = { ...events[used], pool: RAPID, ticket: { ...events[used].ticket, pool: RAPID } };
  assert.match(replay(events).errors.map(e => e.what).join(), /another pool/);
});

test('an anchor whose state moves, or that is rated as a player, is caught', () => {
  assert.match(tampered(anchored(), e => e.player === 7n, e => ({ mu: e.mu + 1n })).join(), /anchor's state changed/);
  assert.ok(!replay(anchored().map(e => (e.type === 'RatingUpdated' && e.player === 7n && e.pool === RAPID ? { ...e, anchor: false } : e))).ok);
  // Unpinned before its game: the contract voids it, so a rating is caught.
  const c = contract();
  c.pin(RAPID, 7n, ONE);
  c.rate(RAPID, 9n, 7n, 0, { t: T0, bands: [3, 0] });
  const pinned = c.events;
  c.unpin(RAPID, 7n);
  const events = [...pinned.slice(0, 2), pinned.at(-1), ...pinned.slice(2, -1)];
  assert.match(replay(events).errors.map(e => e.what).join(), /anchor true, expected false/);
});

/** Version 2 of the test rules: faster aging and longer minimum games. */
const V2 = {
  ...TEST_RULES,
  version: 2,
  pool: id => (TEST_RULES.pool(id) && { ...TEST_RULES.pool(id), minSteps: 10 }),
  drift: (id, mu) => r.driftOf(10n * ONE),
};

/** Games under version 1, then the contract upgraded to version 2. */
function upgraded() {
  const c = contract();
  let t = T0;
  for (let i = 0; i < 8; i++) c.rate(BLITZ, 1n, 2n, i % 2 ? 2 : 0, { t: (t += 86400n) });
  for (let i = 0; i < 8; i++) c.rate(BLITZ, 2n, 1n, i % 3 ? 2 : 0, { t: (t += 86400n * 3n), rules: V2 });
  c.rate(BLITZ, 1n, 3n, 2, { t: (t += 86400n), steps: 6, rules: V2 }); // short under version 2 only
  return c.events;
}

test('each game replays under the rules of its version', () => {
  assert.deepEqual(replay(upgraded(), { 1: TEST_RULES, 2: V2 }).errors, []);
  assert.deepEqual(replay(upgraded(), new Map([[1, TEST_RULES], [2, V2]])).errors, []);
  assert.deepEqual(replay(upgraded(), params => (params === 1 ? TEST_RULES : params === 2 ? V2 : null)).errors, []);
  // A version without rules is reported, and the chain goes on from its reported states.
  const missing = replay(upgraded(), TEST_RULES).errors;
  assert.equal(missing.length, 9);
  assert.ok(missing.every(e => e.what === 'no rules for params 2'));
  assert.ok(replay(upgraded(), { 2: V2 }).errors.every(e => e.what === 'no rules for params 1'));
  // The versions differ: version 2's games don't replay under version 1's rules.
  assert.ok(replay(upgraded(), { 1: TEST_RULES, 2: { ...TEST_RULES, version: 2 } }).errors.some(e => /post-game/.test(e.what)));
});

test('a pool id is a short string, or a felt in any form JSON and RPC give', () => {
  const blitz = 0x626c69747an;
  assert.equal(r.poolId('blitz'), blitz);
  assert.equal(r.poolId(blitz), blitz);
  assert.equal(r.poolId('0x626c69747a'), blitz);
  assert.equal(r.poolId('0x626C69747A'), blitz);
});
