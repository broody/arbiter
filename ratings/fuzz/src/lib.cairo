//! Fuzz properties of `arbiter_ratings::math`. Run with
//! `~/.asdf/shims/snforge test` in this directory (an older snforge on PATH
//! may shadow it). Random u64/u128 inputs are folded onto storable states of
//! one of two pools that age at different rates: μ in the pool's range, φ in
//! {new} ∪ [min φ, φ0], any u64 times.
#[cfg(test)]
mod tests {
    use arbiter_ratings::math::{self, ONE, Rating};
    use arbiter_ratings::{Pool, RatingRules, drift_of, elo};

    const SLOW: felt252 = 'slow';
    const FAST: felt252 = 'fast';

    fn fuzz_pool() -> Pool {
        Pool {
            phi0: 2 * ONE,
            min_phi: 42949673,
            mu_min: -34613345405,
            mu_max: 49447636293,
            provisional_phi: ONE,
            settled_games: 10,
            min_steps: 20,
            anchor_phi: ONE / 4,
            anchor_mu_min: -24105722693,
            anchor_mu_max: 32884882086,
            max_offset: 400,
        }
    }

    /// Two pools, aging with a 45-day and a 15-day half-life (KGS's ends), and
    /// a drift that also depends on μ in the fast pool, as Surround's does.
    impl FuzzRules of RatingRules {
        const TAG: felt252 = 'FUZZ';
        const VERSION: u8 = 1;
        const REFEREE_RNG: bool = false;

        fn pool(pool: felt252) -> Option<Pool> {
            if pool == SLOW || pool == FAST {
                Option::Some(fuzz_pool())
            } else {
                Option::None
            }
        }

        fn start(pool: felt252, band: u8) -> Option<i128> {
            match band {
                1 => Option::Some(-19522877321),
                2 => Option::Some(-13321968437),
                3 => Option::Some(0),
                4 => Option::Some(8341418243),
                _ => Option::None,
            }
        }

        fn drift(pool: felt252, mu: i128) -> i128 {
            if pool == SLOW {
                drift_of(45 * ONE)
            } else if mu < 0 {
                drift_of(15 * ONE)
            } else {
                drift_of(30 * ONE)
            }
        }

        fn shown(pool: felt252, mu: i128, offset: i32) -> u16 {
            elo(mu, offset)
        }
    }

    fn pool_of(x: u8) -> felt252 {
        if x % 2 == 0 {
            SLOW
        } else {
            FAST
        }
    }

    fn mu_of(x: u128) -> i128 {
        let p = fuzz_pool();
        let span: u128 = (p.mu_max - p.mu_min + 1).try_into().unwrap();
        match x % 5 {
            0 => p.mu_min,
            1 => p.mu_max,
            _ => p.mu_min + ((x / 5) % span).try_into().unwrap(),
        }
    }

    fn phi_of(x: u128) -> i128 {
        let p = fuzz_pool();
        let span: u128 = (p.phi0 - p.min_phi + 1).try_into().unwrap();
        match x % 6 {
            0 => 0,
            1 => p.min_phi,
            2 => p.phi0,
            _ => p.min_phi + ((x / 6) % span).try_into().unwrap(),
        }
    }

    fn player(id: felt252, m: u128, p: u128, last: u64, band: u8) -> Rating {
        let phi = phi_of(p);
        if phi == 0 {
            math::start::<FuzzRules>(id, 1 + band % 4).unwrap()
        } else {
            Rating { mu: mu_of(m), phi, last }
        }
    }

    fn check_side(before: Rating, after: Rating, score: u8, opponent_mu: i128, t: u64) {
        let p = fuzz_pool();
        let d = after.mu - before.mu;
        if score == 2 {
            assert!(d >= 0, "winner lost mu");
        } else if score == 0 {
            assert!(d <= 0, "loser gained mu");
        } else if before.mu < opponent_mu {
            assert!(d >= 0, "draw moved the lower player down");
        } else if before.mu > opponent_mu {
            assert!(d <= 0, "draw moved the higher player up");
        }
        assert!(after.mu >= p.mu_min && after.mu <= p.mu_max, "mu out of clamp");
        assert!(after.phi >= p.min_phi && after.phi <= p.phi0, "phi out of range");
        assert!(after.last >= before.last && after.last >= t, "clock moved back");
        // |Δμ| ≤ φ0²·g·1 < 4 logits.
        assert!(d < 4 * ONE && d > -4 * ONE, "step too large");
    }

    #[test]
    #[fuzzer(runs: 3000, seed: 20261011)]
    fn update_properties(
        am: u128, ap: u128, bm: u128, bp: u128, al: u64, bl: u64, t: u64, result: u8, band: u8,
    ) {
        let id = pool_of(band / 16);
        let p = fuzz_pool();
        let result = result % 3;
        let a = player(id, am, ap, al, band);
        let b = player(id, bm, bp, bl, band / 4);
        let (x, y, q) = math::update::<FuzzRules>(id, @p, a, b, result, t);
        check_side(a, x, result, b.mu, t);
        check_side(b, y, 2 - result, a.mu, t);
        assert!(q >= 0 && q <= ONE, "p out of range");
    }

    /// Aging: φ after a game never exceeds the aged φ, and more idle time
    /// never lowers it (monotone), capped at φ0.
    #[test]
    #[fuzzer(runs: 3000, seed: 7)]
    fn aging_is_monotone_and_capped(
        m: u128, p: u128, om: u128, last: u64, gap: u64, extra: u64, which: u8,
    ) {
        let id = pool_of(which);
        let pool = fuzz_pool();
        let mut phi = phi_of(p);
        if phi == 0 {
            phi = pool.min_phi;
        }
        let me = Rating { mu: mu_of(m), phi, last: last / 2 };
        let opp = Rating { mu: mu_of(om), phi: ONE, last: last / 2 };
        let t1 = me.last + gap / 4;
        let t2 = t1 + extra / 4;
        // Same result against the same opponent: a longer layoff can only leave
        // φ' higher or equal (more uncertainty in, more out).
        let (a, _, _) = math::update::<FuzzRules>(id, @pool, me, opp, 1, t1);
        let (b, _, _) = math::update::<FuzzRules>(id, @pool, me, opp, 1, t2);
        assert!(b.phi >= a.phi, "aging not monotone");
        assert!(b.phi <= pool.phi0, "aging above phi0");
    }

    /// The slower pool never ages a player more than the faster one.
    #[test]
    #[fuzzer(runs: 2000, seed: 13)]
    fn a_longer_half_life_ages_less(m: u128, p: u128, last: u64, gap: u64) {
        let pool = fuzz_pool();
        let mut phi = phi_of(p);
        if phi == 0 {
            phi = pool.min_phi;
        }
        let me = Rating { mu: mu_of(m), phi, last: last / 2 };
        let t = me.last + gap / 4;
        let slow = math::aged_phi::<FuzzRules>(SLOW, @pool, me, t);
        let fast = math::aged_phi::<FuzzRules>(FAST, @pool, me, t);
        assert!(slow <= fast, "slow pool aged more");
    }

    /// Winning is always better than drawing, which is better than losing.
    #[test]
    #[fuzzer(runs: 3000, seed: 11)]
    fn results_are_ordered(
        am: u128, ap: u128, bm: u128, bp: u128, al: u64, bl: u64, t: u64, which: u8,
    ) {
        let id = pool_of(which);
        let pool = fuzz_pool();
        let a = player(id, am, ap, al, 2);
        let b = player(id, bm, bp, bl, 1);
        let (a0, b0, _) = math::update::<FuzzRules>(id, @pool, a, b, 0, t);
        let (a1, b1, _) = math::update::<FuzzRules>(id, @pool, a, b, 1, t);
        let (a2, b2, _) = math::update::<FuzzRules>(id, @pool, a, b, 2, t);
        assert!(a0.mu <= a1.mu && a1.mu <= a2.mu, "seat 0 not ordered");
        assert!(b0.mu >= b1.mu && b1.mu >= b2.mu, "seat 1 not ordered");
        assert!(a0.phi == a1.phi && a1.phi == a2.phi, "phi depends on the result");
    }
}
