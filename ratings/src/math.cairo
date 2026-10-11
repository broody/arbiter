//! The rating update in Q32.32 fixed point (x / 2^32), integer only.
//! `sdk/src/ratings.mjs` mirrors it bit for bit.
//!
//! Glicko-2's update, one game at a time, without the volatility step:
//! deviation grows with idle time instead (φ² grows by c² a day, c from the
//! game's `RatingRules::drift`), the opponent's deviation is aged too, and μ
//! stays within the pool's range. Values are logits on Glicko-2's μ scale;
//! variances are Q64 so aging needs no square root. Every division rounds half
//! to even: truncation would bias ratings downward over millions of updates.
//! i128 arithmetic panics on overflow rather than wrapping; with Surround's
//! constants the largest intermediate is 98 bits.
use core::num::traits::Sqrt;
use crate::rules::{Pool, RatingRules};

pub const ONE: i128 = 0x100000000;
const ONE2: i128 = 0x10000000000000000;
const ONE3: i128 = 0x1000000000000000000000000;
const DAY: i128 = 86400;
const LN2: i128 = 2977044472;
const PI2: i128 = 42389628127;
/// Idle seconds past which aging stops adding (long after any φ0 cap).
const MAX_IDLE: i128 = 0x40000000;
const EXP_STEP: i128 = 0x10000000;
const EXP_CUT: i128 = 33;
const EXP_TERMS: i128 = 6;
/// e^(−j/16) for j = 0…11.
const EXP_T: [i128; 12] = [
    4294967296, 4034748382, 3790295335, 3560652950, 3344923893, 3142265200, 2951884975, 2773039306,
    2605029347, 2447198598, 2298930330, 2159645183,
];
const POW2: [i128; 33] = [
    1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072,
    262144, 524288, 1048576, 2097152, 4194304, 8388608, 16777216, 33554432, 67108864, 134217728,
    268435456, 536870912, 1073741824, 2147483648, 4294967296,
];

/// A player's rating state.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Rating {
    /// μ, Q.
    pub mu: i128,
    /// φ, Q; zero for a player never rated.
    pub phi: i128,
    /// When the player last played, in seconds.
    pub last: u64,
}

/// A new player's state for a starting band. φ = 0 marks it as never rated.
pub fn start<impl R: RatingRules>(pool: felt252, band: u8) -> Option<Rating> {
    match R::start(pool, band) {
        Option::Some(mu) => Option::Some(Rating { mu, phi: 0, last: 0 }),
        Option::None => Option::None,
    }
}

/// One rated game in `pool` (`id`, with constants `p`). `result` is seat 0's
/// score in half points: 2 seat 0 won, 1 draw, 0 seat 1 won. `t` is the game's
/// time. Returns both new states and P(seat 0 wins) before the game (Q).
pub fn update<impl R: RatingRules>(
    id: felt252, p: @Pool, a: Rating, b: Rating, result: u8, t: u64,
) -> (Rating, Rating, i128) {
    let va = variance::<R>(id, p, a, t);
    let vb = variance::<R>(id, p, b, t);
    let q = sigmoid(div(g_of(va + vb) * (a.mu - b.mu), ONE));
    let (a, b) = sides(p, a, b, va, vb, result, t);
    (a, b, q)
}

/// `update` without P(seat 0 wins), which the contract doesn't need.
pub fn update_states<impl R: RatingRules>(
    id: felt252, p: @Pool, a: Rating, b: Rating, result: u8, t: u64,
) -> (Rating, Rating) {
    sides(p, a, b, variance::<R>(id, p, a, t), variance::<R>(id, p, b, t), result, t)
}

fn sides(
    p: @Pool, a: Rating, b: Rating, va: i128, vb: i128, result: u8, t: u64,
) -> (Rating, Rating) {
    let s = match result {
        0 => 0,
        1 => ONE / 2,
        _ => ONE,
    };
    (side(p, a, va, g_of(vb), b.mu, s, t), side(p, b, vb, g_of(va), a.mu, ONE - s, t))
}

/// A rated player's state aged to `t` without a game: φ grows as it would for
/// a game at `t`, and the clock moves to `t`. For the side of a game that
/// doesn't count for it.
pub fn age<impl R: RatingRules>(id: felt252, p: @Pool, player: Rating, t: u64) -> Rating {
    Rating {
        mu: player.mu,
        phi: aged_phi::<R>(id, p, player, t),
        last: if player.last > t {
            player.last
        } else {
            t
        },
    }
}

/// φ aged to `t`, as a game at `t` would use it; φ0 for a player never rated.
pub fn aged_phi<impl R: RatingRules>(id: felt252, p: @Pool, player: Rating, t: u64) -> i128 {
    sqrt(variance::<R>(id, p, player, t))
}

/// Settled: enough games, and aged φ no more than the provisional threshold.
pub fn settled<impl R: RatingRules>(
    id: felt252, p: @Pool, player: Rating, games: u32, t: u64,
) -> bool {
    games >= *p.settled_games && aged_phi::<R>(id, p, player, t) <= *p.provisional_phi
}

/// "?" while φ is above the provisional threshold or the player lacks a win or
/// a loss.
pub fn provisional(p: @Pool, phi: i128, wins: u32, losses: u32) -> bool {
    phi > *p.provisional_phi || wins == 0 || losses == 0
}

/// n / d rounded half to even, for d > 0. Symmetric in the sign of n.
pub fn div(n: i128, d: i128) -> i128 {
    if n < 0 {
        return -div(-n, d);
    }
    let n: u128 = n.try_into().unwrap();
    let d: u128 = d.try_into().unwrap();
    let (q, r) = DivRem::div_rem(n, d.try_into().unwrap());
    let r2 = r + r;
    let q = if r2 > d || (r2 == d && q % 2 == 1) {
        q + 1
    } else {
        q
    };
    q.try_into().unwrap()
}

/// The nearest integer to √n.
pub fn sqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    let n: u128 = n.try_into().unwrap();
    let s: u128 = n.sqrt().into();
    let s = if n - s * s > s {
        s + 1
    } else {
        s
    };
    s.try_into().unwrap()
}

/// e^(−x) for x ≥ 0: x = n·ln 2 + r and e^(−r) = T[j]·e^(−u), u < 1/16, by Horner.
pub fn exp_neg(x: i128) -> i128 {
    let n = quot(x, LN2);
    if n >= EXP_CUT {
        return 0;
    }
    let r = x - n * LN2;
    let j = quot(r, EXP_STEP);
    let u = r - j * EXP_STEP;
    let mut acc = ONE;
    let mut k = EXP_TERMS;
    while k > 0 {
        acc = ONE - div(u * acc, ONE * k);
        k -= 1;
    }
    let j: u32 = j.try_into().unwrap();
    let e = div(*EXP_T.span()[j] * acc, ONE);
    if n == 0 {
        e
    } else {
        let n: u32 = n.try_into().unwrap();
        div(e, *POW2.span()[n])
    }
}

/// 1 / (1 + e^(−z)), Q.
pub fn sigmoid(z: i128) -> i128 {
    if z >= 0 {
        div(ONE2, ONE + exp_neg(z))
    } else {
        let e = exp_neg(-z);
        div(e * ONE, ONE + e)
    }
}

/// Floor of n / d for n ≥ 0 and d > 0.
pub fn quot(n: i128, d: i128) -> i128 {
    let n: u128 = n.try_into().unwrap();
    let d: u128 = d.try_into().unwrap();
    (n / d).try_into().unwrap()
}

/// g = 1/√(1 + 3·var/π²) for a Q64 variance.
fn g_of(variance: i128) -> i128 {
    sqrt(div(ONE3, ONE + div(3 * variance, PI2)))
}

/// The variance a player brings to a game at `t`: φ0² for a new player,
/// otherwise min(φ0², φ² + c²·idle days), with c from the rules at the
/// player's μ.
fn variance<impl R: RatingRules>(id: felt252, p: @Pool, player: Rating, t: u64) -> i128 {
    let phi0_2 = *p.phi0 * *p.phi0;
    if player.phi == 0 {
        return phi0_2;
    }
    let base = player.phi * player.phi;
    if t <= player.last {
        return base;
    }
    let mut dt: i128 = (t - player.last).into();
    if dt > MAX_IDLE {
        dt = MAX_IDLE;
    }
    let c = R::drift(id, player.mu);
    let aged = base + div(c * c * dt, DAY);
    if aged > phi0_2 {
        phi0_2
    } else {
        aged
    }
}

fn side(
    p: @Pool, player: Rating, variance: i128, g: i128, opponent_mu: i128, s: i128, t: u64,
) -> Rating {
    let e = sigmoid(div(g * (player.mu - opponent_mu), ONE));
    // g²E(1 − E), the game's information.
    let info = div(div(g * g, ONE) * div(e * (ONE - e), ONE), ONE);
    // φ'², Q64.
    let v2 = div(ONE3, div(ONE3, variance) + info);
    // φ'²·g·(s − E).
    let delta = div(div(v2 * g, ONE2) * (s - e), ONE);
    let phi = sqrt(v2);
    Rating {
        mu: clamp(p, player.mu + delta),
        phi: if phi < *p.min_phi {
            *p.min_phi
        } else {
            phi
        },
        last: if player.last > t {
            player.last
        } else {
            t
        },
    }
}

fn clamp(p: @Pool, mu: i128) -> i128 {
    if mu < *p.mu_min {
        *p.mu_min
    } else if mu > *p.mu_max {
        *p.mu_max
    } else {
        mu
    }
}
