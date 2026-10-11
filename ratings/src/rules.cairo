//! What a game decides about its ratings, compiled into its ratings contract:
//! its pools and their constants, starting ratings, how fast uncertainty grows
//! while a player is idle, and the rank it shows. A game implements
//! `RatingRules` once, as it implements `GameRules`, and builds its contract
//! from `RatingsComponent` with it. Changing a rule means upgrading the
//! contract, which waits for the timelock once it is sealed.
use crate::math::{ONE, div};

/// A pool's constants, in Q32.32 logits (Glicko-2's μ scale) where they are
/// ratings or deviations.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Pool {
    /// A new player's deviation, below 4 (`PHI_LIMIT`).
    pub phi0: i128,
    /// The deviation floor.
    pub min_phi: i128,
    /// Stored μ stays within these.
    pub mu_min: i128,
    pub mu_max: i128,
    /// A rank shows "?" while the deviation, aged to now, is above this.
    pub provisional_phi: i128,
    /// A player counts as settled from this many games, with aged φ at most
    /// `provisional_phi`; only games between settled players move a peak.
    pub settled_games: u32,
    /// Games shorter than this, in steps, are void, except onchain forfeits,
    /// which only the loser's rating feels.
    pub min_steps: u32,
    /// An anchor's fixed deviation, and the μ it may be pinned at.
    pub anchor_phi: i128,
    pub anchor_mu_min: i128,
    pub anchor_mu_max: i128,
    /// The largest rank offset the owner may set, in `shown`'s units.
    pub max_offset: i32,
}

pub trait RatingRules {
    /// Domain tag in every ticket digest and admin op, e.g. 'SURROUND'.
    const TAG: felt252;
    /// Version of the rules that last updated a player, stored with it
    /// (`params`). Bump it when an update would change.
    const VERSION: u8;
    /// Rated games take their randomness from the referee (a game with dice),
    /// or never take any.
    const REFEREE_RNG: bool;
    /// A pool's constants, or None for a pool the game doesn't have.
    fn pool(pool: felt252) -> Option<Pool>;
    /// A new player's μ for a starting band, 1 to 7, or None.
    fn start(pool: felt252, band: u8) -> Option<i128>;
    /// c, the growth of φ per √day idle at μ (Q): φ² grows by c² a day.
    fn drift(pool: felt252, mu: i128) -> i128;
    /// The rank shown for μ with the owner's offset, e.g. `elo(mu, offset)`.
    fn shown(pool: felt252, mu: i128, offset: i32) -> u16;
}

/// Signed values are stored biased in 40 bits, so μ, peaks and pinned μ stay
/// within ±2^39 (about ±128 logits).
pub const BIAS_40: i128 = 0x8000000000;
/// Deviations are stored in 34 bits: below 4.
pub const PHI_LIMIT: i128 = 0x400000000;

/// Whether a pool's constants fit the packed player state and make sense:
/// μ, peaks (μ − 2φ) and anchors within ±2^39, deviations below 4.
pub fn valid_pool(pool: @Pool) -> bool {
    let p = *pool;
    p.min_phi > 0
        && p.min_phi <= p.provisional_phi
        && p.provisional_phi <= p.phi0
        && p.phi0 < PHI_LIMIT
        && p.anchor_phi >= p.min_phi
        && p.anchor_phi < PHI_LIMIT
        && p.mu_min < p.mu_max
        && (p.mu_min - 2 * p.phi0) >= -BIAS_40
        && p.mu_max < BIAS_40
        && p.anchor_mu_min <= p.anchor_mu_max
        && p.anchor_mu_min >= p.mu_min
        && p.anchor_mu_max <= p.mu_max
        && p.max_offset >= 0
}

/// 1.15·2·ln 2 scaled by 2^64: c for a half-life of h days is
/// `div(C_HALF_LIFE, h)`, with h in Q (KGS's drift).
pub const C_HALF_LIFE: i128 = 29408509883171471360;

/// c for a half-life in days (Q).
pub fn drift_of(half_life: i128) -> i128 {
    div(C_HALF_LIFE, half_life)
}

/// 400 / ln 10 in Q: Elo points per logit.
pub const ELO_SCALE: i128 = 746112238643;

/// The Elo-scale rating for μ, 1500 + 173.7178·μ, rounded half to even, plus
/// `offset`, held to 0..=65535.
pub fn elo(mu: i128, offset: i32) -> u16 {
    let rating = div(1500 * ONE + div(ELO_SCALE * mu, ONE), ONE) + offset.into();
    if rating < 0 {
        0
    } else if rating > 0xffff {
        0xffff
    } else {
        rating.try_into().unwrap()
    }
}
