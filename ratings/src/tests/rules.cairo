//! A chess-shaped game's rules for the tests: two pools with flat aging at
//! different half-lives, Elo-scale ranks, and bands at 800, 1200, 1500, 1800,
//! 2100 and 2400 (none at band 6). `sdk/test` mirrors them (`TEST_RULES`).
use crate::math::ONE;
use crate::rules::{Pool, RatingRules, drift_of, elo};

pub const BLITZ: felt252 = 'blitz';
pub const RAPID: felt252 = 'rapid';

pub fn test_pool() -> Pool {
    Pool {
        phi0: 2 * ONE,
        min_phi: 42949673,
        mu_min: -34613345405,
        mu_max: 49447636293,
        provisional_phi: ONE,
        settled_games: 10,
        min_steps: 4,
        anchor_phi: ONE / 4,
        anchor_mu_min: -24105722693,
        anchor_mu_max: 32884882086,
        max_offset: 400,
    }
}

pub impl TestRules of RatingRules {
    const TAG: felt252 = 'TEST';
    const VERSION: u8 = 1;
    const REFEREE_RNG: bool = false;

    fn pool(pool: felt252) -> Option<Pool> {
        if pool == BLITZ || pool == RAPID {
            Option::Some(test_pool())
        } else {
            Option::None
        }
    }

    fn start(pool: felt252, band: u8) -> Option<i128> {
        match band {
            1 => Option::Some(-17306673424),
            2 => Option::Some(-7417145753),
            3 => Option::Some(0),
            4 => Option::Some(7417145753),
            5 => Option::Some(14834291506),
            7 => Option::Some(22251437259),
            _ => Option::None,
        }
    }

    fn drift(pool: felt252, mu: i128) -> i128 {
        if pool == BLITZ {
            drift_of(30 * ONE)
        } else {
            drift_of(60 * ONE)
        }
    }

    fn shown(pool: felt252, mu: i128, offset: i32) -> u16 {
        elo(mu, offset)
    }
}
