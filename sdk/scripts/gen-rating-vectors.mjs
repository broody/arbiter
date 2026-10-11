// Writes ratings/src/tests/vectors.cairo and test_vectors.cairo from the SDK's
// integer rating update (sdk/src/ratings.mjs) under the tests' rules
// (`TEST_RULES`, sdk/test/rating-rules.mjs), so arbiter_ratings' Cairo engine is
// checked bit for bit against the reference: the rules' pools, starts and
// drift, the primitives, edge cases, a seeded sequence of games among players
// from every band in both pools, aging, the Elo display, `valid_pool`, and a
// ticket's digest. Run after changing either side.
// Usage (from the repo root): node sdk/scripts/gen-rating-vectors.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hex, standardTime, tag } from '../src/index.mjs';
import * as r from '../src/ratings.mjs';
import { BLITZ, POOL_CASES, RAPID, SDK_RATINGS, SDK_SETTINGS, SDK_TICKET, TEST_RULES, testPool } from '../test/rating-rules.mjs';

const { ONE } = r;
const T0 = 1_700_000_000n;
const DAY = 86400n;
const LN2 = 2977044472n;
const p = testPool();
const BULLET = tag('bullet');
const NAMES = new Map([[BLITZ, "'blitz'"], [RAPID, "'rapid'"], [BULLET, "'bullet'"]]);
const poolName = id => NAMES.get(id) ?? hex(id);
const at = (mu, phi, last) => ({ mu, phi, last });
const mu = band => r.start(TEST_RULES, BLITZ, band).mu;
const rating = x => `Rating { mu: ${x.mu}, phi: ${x.phi}, last: ${x.last} }`;
const option = x => (x == null ? 'Option::None' : `Option::Some(${x})`);
const bool = x => (x ? 'true' : 'false');
const poolCairo = x => `Pool { phi0: ${x.phi0}, min_phi: ${x.minPhi}, mu_min: ${x.muMin}, mu_max: ${x.muMax}, `
  + `provisional_phi: ${x.provisionalPhi}, settled_games: ${x.settledGames}, min_steps: ${x.minSteps}, `
  + `anchor_phi: ${x.anchorPhi}, anchor_mu_min: ${x.anchorMuMin}, anchor_mu_max: ${x.anchorMuMax}, max_offset: ${x.maxOffset} }`;
const list = (name, type, doc, rows) => [
  `/// ${doc}`, `pub fn ${name}() -> Array<${type}> {`, '    array![', ...rows.map(row => `        ${row},`), '    ]', '}', ''];

// Deterministic pseudo-random numbers (xorshift32).
let seed = 0x5eed;
const next = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 2 ** 32; };
const big = bits => BigInt(Math.floor(next() * 2 ** 26)) << BigInt(Math.max(0, bits - 26));

// ---- Primitives ----
const divs = [[5n, 2n], [7n, 2n], [-5n, 2n], [-7n, 2n], [10n, 3n], [11n, 3n], [-11n, 3n], [0n, 7n], [1n, 1n],
  [ONE * ONE * ONE, ONE + 1n], [-(ONE * ONE) - ONE / 2n, ONE], [3n * ONE / 2n, ONE], [5n * ONE / 2n, ONE]];
for (let i = 0; i < 12; i++) divs.push([(next() < 0.5 ? -1n : 1n) * big(100), 1n + big(40)]);
const quots = [[7n, 2n], [0n, 5n], [9n, 10n], [LN2 * 33n, LN2], [LN2 * 33n - 1n, LN2], [(1n << 126n) + 12345n, ONE + 3n]];
const sqrts = [0n, 1n, 2n, 3n, 4n, 6n, 7n, -4n, ONE, ONE * ONE, ONE * ONE * ONE - 1n, (1n << 127n) - 1n];
for (let i = 0; i < 12; i++) sqrts.push(big(20 + Math.floor(next() * 100)));
const exps = [0n, 1n, ONE / 32n, ONE, LN2, LN2 - 1n, 33n * LN2 - 1n, 33n * LN2, 40n * ONE];
for (let x = 0n; x < 24n * ONE; x += 1234567891n) exps.push(x);
const sigmoids = [0n, 1n, -1n, ONE, -ONE, 30n * ONE, -30n * ONE];
for (let z = -16n * ONE; z <= 16n * ONE; z += 3456789012n) sigmoids.push(z);

// ---- The rules ----
const starts = [BLITZ, RAPID, BULLET].flatMap(pool =>
  [0, 1, 2, 3, 4, 5, 6, 7, 8].map(band => `(${poolName(pool)}, ${band}, ${option(TEST_RULES.start(pool, band))})`));
const drifts = [BLITZ, RAPID, BULLET].flatMap(pool =>
  [p.muMin, 0n, p.muMax].map(m => `(${poolName(pool)}, ${m}, ${TEST_RULES.drift(pool, m)})`));

// ---- Edge cases: [label, pool, seat 0, seat 1, result, t] ----
const fresh = band => r.start(TEST_RULES, BLITZ, band);
const pin = at(mu(4), p.anchorPhi, T0);
const cases = [
  ['both new, equal bands', BLITZ, fresh(3), fresh(3), 2, T0],
  ['new 800 beats new 2400', BLITZ, fresh(1), fresh(7), 2, T0],
  ['new 2100 loses to new 1200 in rapid', RAPID, fresh(5), fresh(2), 0, T0],
  ['a new player draws an established one', BLITZ, fresh(2), at(mu(4) + 12345n, ONE / 2n, T0 - DAY), 1, T0],
  ['established equals', RAPID, at(ONE, ONE / 3n, T0 - 3600n), at(ONE, ONE / 3n, T0 - 7200n), 0, T0],
  ['the favourite wins', BLITZ, at(mu(7), ONE / 4n, T0 - DAY), at(mu(2), ONE / 4n, T0 - DAY), 2, T0],
  ['a huge upset', BLITZ, at(p.muMin, ONE / 4n, T0 - DAY), at(p.muMax, ONE / 4n, T0 - DAY), 2, T0],
  ['clamped at both ends', RAPID, at(p.muMax, p.phi0, T0 - DAY), at(p.muMin, p.phi0, T0 - DAY), 2, T0],
  ['a year idle, blitz', BLITZ, at(ONE, ONE / 5n, T0 - 365n * DAY), at(ONE, ONE / 5n, T0 - 60n), 0, T0],
  ['a year idle, rapid', RAPID, at(ONE, ONE / 5n, T0 - 365n * DAY), at(ONE, ONE / 5n, T0 - 60n), 0, T0],
  ['a month idle, blitz', BLITZ, at(-ONE, ONE / 2n, T0 - 30n * DAY), at(mu(5), ONE, T0 - 3n * DAY), 2, T0],
  ['a month idle, rapid', RAPID, at(-ONE, ONE / 2n, T0 - 30n * DAY), at(mu(5), ONE, T0 - 3n * DAY), 2, T0],
  ['fifty years idle (idle cap)', RAPID, at(mu(1), p.minPhi, 0n), at(mu(1), ONE / 2n, T0 - 60n), 2, T0],
  ['rated out of order', BLITZ, at(mu(3), ONE / 2n, T0 + 5000n), at(mu(4), ONE / 2n, T0 + 9000n), 2, T0],
  ['the same second', RAPID, at(mu(3), ONE / 2n, T0), at(mu(3), ONE / 2n, T0), 1, T0],
  ['minimum deviation', BLITZ, at(mu(5), p.minPhi, T0), at(mu(5), p.minPhi, T0), 2, T0],
  ['an anchor\'s pin against a newcomer', RAPID, pin, fresh(3), 2, T0],
  ['a newcomer against an anchor\'s pin', RAPID, fresh(1), pin, 1, T0],
  ['a result above 2 is seat 0\'s win', BLITZ, at(ONE, ONE / 2n, T0 - DAY), at(-ONE, ONE / 2n, T0 - DAY), 255, T0],
];

// ---- A seeded sequence: 12 players per pool, 2 of each band, 300 games over about a year ----
const BANDS = [1, 2, 3, 4, 5, 7];
const players = [BLITZ, RAPID].flatMap(pool => Array.from({ length: 12 }, (_, i) => ({ pool, band: BANDS[i % 6] })));
const states = players.map(x => r.start(TEST_RULES, x.pool, x.band));
const games = [];
let t = T0;
for (let i = 0; i < 300; i++) {
  const base = next() < 0.5 ? 0 : 12;
  const a = base + Math.floor(next() * 12), b = base + (a - base + 1 + Math.floor(next() * 11)) % 12;
  t += BigInt(Math.floor(next() ** 3 * 20 * 86400));
  const result = next() < 0.03 ? 1 : next() < 0.5 ? 2 : 0;
  const pool = players[a].pool;
  const out = r.update(TEST_RULES, pool, states[a], states[b], result, t);
  games.push({ pool, i: a, j: b, result, t, ...out });
  states[a] = out.a; states[b] = out.b;
}

// ---- Aging: [pool, player, t, games] ----
const aging = [
  [BLITZ, fresh(3), T0, 0],
  [RAPID, fresh(7), T0, 10],
  [BLITZ, at(ONE, ONE / 2n, T0), T0, 10],
  [BLITZ, at(ONE, ONE / 2n, T0), T0 + 90n * DAY, 10],
  [RAPID, at(ONE, ONE / 2n, T0), T0 + 90n * DAY, 10],
  [BLITZ, at(mu(7), ONE, T0 - DAY), T0, 30],
  [RAPID, at(mu(1), p.minPhi, T0), T0 + 3n * 365n * DAY, 10],
  [BLITZ, at(mu(1), p.minPhi, 0n), T0, 10],
  [BLITZ, at(0n, ONE, T0), T0, 10],
  [BLITZ, at(0n, ONE, T0), T0, 9],
  [BLITZ, at(0n, ONE, T0), T0 + 1n, 10],
  [RAPID, at(mu(5), ONE - 1n, T0), T0 + 3600n, 10],
  [RAPID, at(mu(5), ONE, T0 + 100n), T0, 10],
];

// ---- Elo: μ and offsets, the bands, the clamp and exact ties ----
const allTies = [];
for (let k = -1500n; k <= 1500n; k++) {
  const inner = k * ONE + ONE / 2n, guess = inner * ONE / r.ELO_SCALE;
  for (const m of [guess - 1n, guess, guess + 1n]) if (r.div(r.ELO_SCALE * m, ONE) === inner) allTies.push(m);
}
// Sixteen, spread over both signs of μ.
const ties = Array.from({ length: 16 }, (_, i) => allTies[Math.floor(i * (allTies.length - 1) / 15)]);
const elos = [
  ...[0n, ONE, -ONE, p.muMin, p.muMax, -10n * ONE, 400n * ONE, r.BIAS_40 - 1n, -r.BIAS_40, ...BANDS.map(mu)]
    .flatMap(m => [-70000, -400, -1, 0, 1, 25, 400, 70000].map(o => [m, o])),
  ...ties.flatMap(m => [[m, 0], [m, 1]]),
].map(([m, o]) => `(${m}, ${o}, ${r.elo(m, o)})`);

const provisional = [[ONE, 1, 1], [ONE + 1n, 1, 1], [ONE / 2n, 3, 0], [ONE / 2n, 0, 3], [p.minPhi, 0, 0], [p.phi0, 5, 5]]
  .map(([phi, w, l]) => `(${phi}, ${w}, ${l}, ${bool(r.provisional(p, phi, w, l))})`);

// ---- The ticket ----
const settings = standardTime.encodeSettings(SDK_SETTINGS);
const digest = r.ticketDigest(SDK_TICKET, TEST_RULES.tag, SDK_RATINGS);
const ticketCairo = [
  'Ticket {',
  `        chain_id: 'SN_SEPOLIA',`,
  ...['channel', 'player_0', 'player_1'].map(k => `        ${k}: ${hex(SDK_TICKET[k])}.try_into().unwrap(),`),
  `        pool: ${poolName(SDK_TICKET.pool)},`,
  ...['config', 'referee', 'clock'].map(k => `        ${k}: ${hex(SDK_TICKET[k])},`),
  `        prover: ${hex(SDK_TICKET.prover)}.try_into().unwrap(),`,
  ...['response_seconds', 'source', 'band_0', 'band_1'].map(k => `        ${k}: ${SDK_TICKET[k]},`),
  `        matchmaker: ${hex(SDK_TICKET.matchmaker)},`,
  ...['issued_at', 'expires_at', 'nonce'].map(k => `        ${k}: ${SDK_TICKET[k]},`),
  '    }',
].join('\n');

const vectors = [
  '// Generated by sdk/scripts/gen-rating-vectors.mjs from sdk/src/ratings.mjs with the',
  '// test rules (sdk/test/rating-rules.mjs). Do not edit by hand.',
  'use crate::math::Rating;',
  'use crate::rules::Pool;',
  '',
  '#[derive(Copy, Drop)]',
  'pub struct Case {',
  '    pub pool: felt252,',
  '    pub a: Rating,',
  '    pub b: Rating,',
  '    pub result: u8,',
  '    pub t: u64,',
  '    pub a_out: Rating,',
  '    pub b_out: Rating,',
  '    pub p: i128,',
  '}',
  '',
  '#[derive(Copy, Drop)]',
  'pub struct Game {',
  '    pub pool: felt252,',
  '    pub a: u32,',
  '    pub b: u32,',
  '    pub result: u8,',
  '    pub t: u64,',
  '    pub a_out: Rating,',
  '    pub b_out: Rating,',
  '    pub p: i128,',
  '}',
  '',
  '#[derive(Copy, Drop)]',
  'pub struct Aging {',
  '    pub pool: felt252,',
  '    pub player: Rating,',
  '    pub t: u64,',
  '    pub games: u32,',
  '    pub phi: i128,',
  '    pub settled: bool,',
  '    pub aged: Rating,',
  '}',
  '',
  `pub const TAG: felt252 = '${TEST_RULES.tag}';`,
  `pub const VERSION: u8 = ${TEST_RULES.version};`,
  `pub const REFEREE_RNG: bool = ${bool(TEST_RULES.refereeRng)};`,
  '',
  '/// The pool both of the test rules\' pools have.',
  'pub fn pool() -> Pool {',
  `    ${poolCairo(p)}`,
  '}',
  '',
  ...list('starts', '(felt252, u8, Option<i128>)', '(pool, band, starting μ) for bands 0 to 8, in each pool and one the rules lack.', starts),
  ...list('drifts', '(felt252, i128, i128)', '(pool, μ, c).', drifts),
  ...list('divs', '(i128, i128, i128)', '(n, d, n / d rounded half to even).', divs.map(([n, d]) => `(${n}, ${d}, ${r.div(n, d)})`)),
  ...list('quots', '(i128, i128, i128)', '(n, d, floor of n / d).', quots.map(([n, d]) => `(${n}, ${d}, ${r.quot(n, d)})`)),
  ...list('sqrts', '(i128, i128)', '(n, nearest integer to √n).', sqrts.map(n => `(${n}, ${r.sqrt(n)})`)),
  ...list('exps', '(i128, i128)', '(x, e^(−x)).', exps.map(x => `(${x}, ${r.expNeg(x)})`)),
  ...list('sigmoids', '(i128, i128)', '(z, 1 / (1 + e^(−z))).', sigmoids.map(z => `(${z}, ${r.sigmoid(z)})`)),
  '/// Edge cases.',
  'pub fn cases() -> Array<Case> {',
  '    array![',
  ...cases.map(([label, pool, a, b, result, time]) => {
    const u = r.update(TEST_RULES, pool, a, b, result, time);
    return [
      `        // ${label}`,
      '        Case {',
      `            pool: ${poolName(pool)},`,
      `            a: ${rating(a)},`,
      `            b: ${rating(b)},`,
      `            result: ${result},`,
      `            t: ${time},`,
      `            a_out: ${rating(u.a)},`,
      `            b_out: ${rating(u.b)},`,
      `            p: ${u.p},`,
      '        },',
    ].join('\n');
  }),
  '    ]',
  '}',
  '',
  ...list('players', '(felt252, u8)', 'Each player in `sequence`: its pool and starting band.',
    players.map(x => `(${poolName(x.pool)}, ${x.band})`)),
  '/// Games among `players`, each within its pool, in order.',
  'pub fn sequence() -> Array<Game> {',
  '    array![',
  ...games.map(g => [
    '        Game {',
    `            pool: ${poolName(g.pool)},`,
    `            a: ${g.i},`,
    `            b: ${g.j},`,
    `            result: ${g.result},`,
    `            t: ${g.t},`,
    `            a_out: ${rating(g.a)},`,
    `            b_out: ${rating(g.b)},`,
    `            p: ${g.p},`,
    '        },',
  ].join('\n')),
  '    ]',
  '}',
  '',
  '/// Aging for the side a game skips: aged φ, settled with `games` games, and the aged state.',
  'pub fn aging() -> Array<Aging> {',
  '    array![',
  ...aging.map(([pool, x, time, n]) => [
    '        Aging {',
    `            pool: ${poolName(pool)},`,
    `            player: ${rating(x)},`,
    `            t: ${time},`,
    `            games: ${n},`,
    `            phi: ${r.agedPhi(TEST_RULES, pool, x, time)},`,
    `            settled: ${bool(r.settled(TEST_RULES, pool, x, n, time))},`,
    `            aged: ${rating(r.age(TEST_RULES, pool, x, time))},`,
    '        },',
  ].join('\n')),
  '    ]',
  '}',
  '',
  ...list('provisional', '(i128, u32, u32, bool)', '(φ, wins, losses, provisional) in the test pool.', provisional),
  ...list('elos', '(i128, i32, u16)', '(μ, offset, Elo shown): the bands, the clamp at both ends and exact ties.', elos),
  ...list('pools', '(Pool, bool)', 'Pools around each bound of `valid_pool`, and whether it holds.',
    POOL_CASES.map(([, change]) => { const x = { ...p, ...change }; return `(${poolCairo(x)}, ${bool(r.validPool(x))})`; })),
];

const tests = `//! Generated by sdk/scripts/gen-rating-vectors.mjs: arbiter_ratings' engine
//! under \`TestRules\` against the SDK's (sdk/src/ratings.mjs), bit for bit, on
//! the vectors in vectors.cairo. Do not edit by hand.
use core::poseidon::poseidon_hash_span;
use crate::math::{self, Rating};
use crate::rules::{elo, valid_pool};
use crate::tests::rules::{TestRules, test_pool};
use crate::tests::vectors;
use crate::ticket::{Ticket, digest};

#[test]
fn the_rules_match_the_sdk() {
    assert_eq!(TestRules::TAG, vectors::TAG);
    assert_eq!(TestRules::VERSION, vectors::VERSION);
    assert_eq!(TestRules::REFEREE_RNG, vectors::REFEREE_RNG);
    assert_eq!(test_pool(), vectors::pool());
    assert!(valid_pool(@vectors::pool()));
    for (pool, band, mu) in vectors::starts() {
        assert_eq!(TestRules::start(pool, band), mu);
        let expected = match mu {
            Option::Some(mu) => Option::Some(Rating { mu, phi: 0, last: 0 }),
            Option::None => Option::None,
        };
        assert_eq!(math::start::<TestRules>(pool, band), expected);
    }
    for (pool, mu, c) in vectors::drifts() {
        assert_eq!(TestRules::drift(pool, mu), c);
    }
}

#[test]
fn primitives_match_the_sdk() {
    for (n, d, q) in vectors::divs() {
        assert_eq!(math::div(n, d), q);
    }
    for (n, d, q) in vectors::quots() {
        assert_eq!(math::quot(n, d), q);
    }
    for (n, s) in vectors::sqrts() {
        assert_eq!(math::sqrt(n), s);
    }
    for (x, e) in vectors::exps() {
        assert_eq!(math::exp_neg(x), e);
    }
    for (z, s) in vectors::sigmoids() {
        assert_eq!(math::sigmoid(z), s);
    }
}

#[test]
fn cases_match_the_sdk() {
    for case in vectors::cases() {
        let p = TestRules::pool(case.pool).unwrap();
        let (a, b, q) = math::update::<TestRules>(case.pool, @p, case.a, case.b, case.result, case.t);
        assert_eq!(a, case.a_out);
        assert_eq!(b, case.b_out);
        assert_eq!(q, case.p);
        let states = math::update_states::<TestRules>(case.pool, @p, case.a, case.b, case.result, case.t);
        assert_eq!(states, (a, b));
    }
}

#[test]
fn the_sequence_matches_the_sdk() {
    let mut players = array![];
    for (pool, band) in vectors::players() {
        players.append(math::start::<TestRules>(pool, band).unwrap());
    }
    let mut players = players.span();
    for game in vectors::sequence() {
        let p = TestRules::pool(game.pool).unwrap();
        let (a, b, q) = math::update::<
            TestRules,
        >(game.pool, @p, *players[game.a], *players[game.b], game.result, game.t);
        assert_eq!(a, game.a_out);
        assert_eq!(b, game.b_out);
        assert_eq!(q, game.p);
        players = replace(replace(players, game.a, a), game.b, b);
    }
}

#[test]
fn aging_matches_the_sdk() {
    for case in vectors::aging() {
        let p = TestRules::pool(case.pool).unwrap();
        assert_eq!(math::aged_phi::<TestRules>(case.pool, @p, case.player, case.t), case.phi);
        assert_eq!(math::settled::<TestRules>(case.pool, @p, case.player, case.games, case.t), case.settled);
        assert_eq!(math::age::<TestRules>(case.pool, @p, case.player, case.t), case.aged);
    }
    let p = test_pool();
    for (phi, wins, losses, provisional) in vectors::provisional() {
        assert_eq!(math::provisional(@p, phi, wins, losses), provisional);
    }
}

#[test]
fn elo_matches_the_sdk() {
    for (mu, offset, shown) in vectors::elos() {
        assert_eq!(elo(mu, offset), shown);
    }
}

#[test]
fn valid_pool_matches_the_sdk() {
    for (pool, valid) in vectors::pools() {
        assert_eq!(valid_pool(@pool), valid);
    }
}

/// The digest the SDK's \`ticketDigest\` computes for the same ticket and
/// ratings contract (sdk/test/ratings.test.mjs), whose clock is the Poseidon
/// hash of its settings as \`clock_presets\` keys them (\`clockHash\`).
#[test]
fn digest_matches_the_sdk() {
    let ticket = ${ticketCairo};
    let settings = array![${settings.join(', ')}];
    assert_eq!(poseidon_hash_span(settings.span()), ticket.clock);
    assert_eq!(digest::<TestRules>(@ticket, ${hex(SDK_RATINGS)}.try_into().unwrap()), SDK_DIGEST);
}

const SDK_DIGEST: felt252 = ${hex(digest)};

fn replace(players: Span<Rating>, index: u32, rating: Rating) -> Span<Rating> {
    let mut out = array![];
    for i in 0..players.len() {
        out.append(if i == index {
            rating
        } else {
            *players[i]
        });
    }
    out.span()
}
`;

const root = fileURLToPath(new URL('../../', import.meta.url));
const targets = ['ratings/src/tests/vectors.cairo', 'ratings/src/tests/test_vectors.cairo'].map(f => `${root}${f}`);
writeFileSync(targets[0], vectors.join('\n'));
writeFileSync(targets[1], tests);
// Format only these two files: other tests in the crate may be in progress.
const env = { ...process.env, SCARB_IGNORE_CAIRO_VERSION: 'true', ASDF_SCARB_VERSION: process.env.ASDF_SCARB_VERSION ?? '2.13.1' };
for (const target of targets) execFileSync('scarb', ['fmt', target], { cwd: root, env, stdio: 'inherit' });
console.log(`wrote ${cases.length} cases, a ${games.length}-game sequence among ${players.length} players, `
  + `${aging.length} aging and ${elos.length} Elo vectors; ticket digest ${hex(digest)}`);
