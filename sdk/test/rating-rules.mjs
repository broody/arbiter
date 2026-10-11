// The tests' rules, the mirror of `TestRules` (ratings/src/tests/rules.cairo):
// a chess-shaped game with two pools, flat aging at different half-lives,
// Elo-scale ranks, and bands at 800, 1200, 1500, 1800, 2100 and 2400 (none at
// band 6). Keep them equal; the vectors (sdk/scripts/gen-rating-vectors.mjs)
// check the pool, starts and drift against the Cairo.
import { standardTime, tag } from '../src/index.mjs';
import { BIAS_40, ONE, PHI_LIMIT, QUEUE, clockHash, driftOf, elo } from '../src/ratings.mjs';

export const BLITZ = tag('blitz'), RAPID = tag('rapid');

export const testPool = () => ({
  phi0: 2n * ONE,
  minPhi: 42949673n,
  muMin: -34613345405n,
  muMax: 49447636293n,
  provisionalPhi: ONE,
  settledGames: 10,
  minSteps: 4,
  anchorPhi: ONE / 4n,
  anchorMuMin: -24105722693n,
  anchorMuMax: 32884882086n,
  maxOffset: 400,
});

const START = { 1: -17306673424n, 2: -7417145753n, 3: 0n, 4: 7417145753n, 5: 14834291506n, 7: 22251437259n };

export const TEST_RULES = {
  tag: 'TEST',
  version: 1,
  refereeRng: false,
  pool: id => (id === BLITZ || id === RAPID ? testPool() : null),
  // Every pool id, as the Cairo matches only the band.
  start: (id, band) => START[band] ?? null,
  drift: id => (id === BLITZ ? driftOf(30n * ONE) : driftOf(60n * ONE)),
  shown: (id, mu, offset) => elo(mu, offset),
};

/**
 * Pools around the bounds of `valid_pool`, with the answer it gives: the test
 * pool with one constant changed, at each bound and just past it.
 */
export const POOL_CASES = [
  ['the test pool', {}, true],
  ['minimum deviation zero', { minPhi: 0n }, false],
  ['minimum deviation at the provisional one', { minPhi: ONE, anchorPhi: ONE }, true],
  ['minimum deviation above the provisional one', { minPhi: ONE + 1n, anchorPhi: ONE + 1n }, false],
  ['provisional deviation at φ0', { provisionalPhi: 2n * ONE }, true],
  ['provisional deviation above φ0', { provisionalPhi: 2n * ONE + 1n }, false],
  ['φ0 just below 4', { phi0: PHI_LIMIT - 1n }, true],
  ['φ0 at 4', { phi0: PHI_LIMIT, provisionalPhi: ONE }, false],
  ['anchor deviation at the minimum', { anchorPhi: 42949673n }, true],
  ['anchor deviation below the minimum', { anchorPhi: 42949672n }, false],
  ['anchor deviation at 4', { anchorPhi: PHI_LIMIT }, false],
  ['an empty μ range', { muMax: -34613345405n, anchorMuMin: -34613345405n, anchorMuMax: -34613345405n }, false],
  ['lowest peak at -2^39', { muMin: -BIAS_40 + 4n * ONE, anchorMuMin: -BIAS_40 + 4n * ONE }, true],
  ['lowest peak below -2^39', { muMin: -BIAS_40 + 4n * ONE - 1n, anchorMuMin: -BIAS_40 + 4n * ONE }, false],
  ['highest μ just below 2^39', { muMax: BIAS_40 - 1n }, true],
  ['highest μ at 2^39', { muMax: BIAS_40, anchorMuMax: 32884882086n }, false],
  ['an empty anchor range', { anchorMuMin: 1n, anchorMuMax: 0n }, false],
  ['a one-point anchor range', { anchorMuMin: 0n, anchorMuMax: 0n }, true],
  ['anchors below the μ range', { anchorMuMin: -34613345406n }, false],
  ['anchors above the μ range', { anchorMuMax: 49447636294n }, false],
  ['anchors over the whole μ range', { anchorMuMin: -34613345405n, anchorMuMax: 49447636293n }, true],
  ['no rank offset', { maxOffset: 0 }, true],
  ['a negative largest offset', { maxOffset: -1 }, false],
];

/** A fixed ticket and ratings contract, whose digest the Cairo checks (`digest_matches_the_sdk`). */
export const SDK_SETTINGS = { turn_ms: 30000, bank_ms: 180000, increment_ms: 2000, byoyomi: null };
export const SDK_RATINGS = 0x7a71e5n;
export const SDK_TICKET = {
  chain_id: tag('SN_SEPOLIA'), channel: 0x111n, player_0: 0x222n, player_1: 0x333n, pool: BLITZ,
  config: 0xc0f1925n, referee: 0x444n, clock: clockHash(standardTime.encodeSettings(SDK_SETTINGS)), prover: 0x555n,
  response_seconds: 600, source: QUEUE, band_0: 3, band_1: 7, matchmaker: 0x666n, issued_at: 1_700_000_000n,
  expires_at: 1_700_000_300n, nonce: 7n,
};
