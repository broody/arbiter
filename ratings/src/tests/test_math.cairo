use crate::math::{self, ONE, Rating};
use crate::rules::{drift_of, elo};
use crate::tests::rules::{BLITZ, RAPID, TestRules, test_pool};

const T0: u64 = 1_700_000_000;
const DAY: u64 = 86400;

#[test]
fn primitives() {
    assert_eq!(math::div(5, 2), 2);
    assert_eq!(math::div(7, 2), 4);
    assert_eq!(math::div(-5, 2), -2);
    assert_eq!(math::div(-7, 2), -4);
    assert_eq!(math::div(11, 3), 4);
    assert_eq!(math::sqrt(6), 2);
    assert_eq!(math::sqrt(7), 3);
    assert_eq!(math::sqrt(0), 0);
    assert_eq!(math::exp_neg(0), ONE);
    assert_eq!(math::exp_neg(23 * ONE), 0);
    assert_eq!(math::sigmoid(0), ONE / 2);
}

#[test]
fn bands() {
    for pool in array![BLITZ, RAPID] {
        assert!(math::start::<TestRules>(pool, 0).is_none());
        assert!(math::start::<TestRules>(pool, 6).is_none());
        assert!(math::start::<TestRules>(pool, 8).is_none());
        let mut shown: Array<u16> = array![];
        for band in array![1_u8, 2, 3, 4, 5, 7] {
            let start = math::start::<TestRules>(pool, band).unwrap();
            // Never rated: φ is zero until the first game.
            assert_eq!((start.phi, start.last), (0, 0));
            shown.append(elo(start.mu, 0));
        }
        assert_eq!(shown, array![800, 1200, 1500, 1800, 2100, 2400]);
    }
    let p = test_pool();
    assert_eq!(elo(p.mu_min, 0), 100);
    assert_eq!(elo(p.mu_max, 0), 3500);
}

/// No state the contract can store, at any time, makes the update panic.
#[test]
#[available_gas(20000000000)]
fn extremes_never_panic() {
    let p = test_pool();
    let mus = array![
        p.mu_min, p.mu_min - 0x10000000000, -ONE, 0, ONE, p.mu_max, p.mu_max + 0x10000000000,
    ];
    let phis = array![0, p.min_phi, ONE / 7, ONE, p.phi0];
    let times: Array<u64> = array![0, T0, 0xffffffffffffffff];
    for pool in array![BLITZ, RAPID] {
        for mu in mus.span() {
            for phi in phis.span() {
                for last in times.span() {
                    for t in times.span() {
                        for result in 0..3_u8 {
                            let a = Rating { mu: *mu, phi: *phi, last: *last };
                            let b = Rating { mu: -*mu, phi: p.phi0 - *phi, last: T0 };
                            let (x, y, q) = math::update::<TestRules>(pool, @p, a, b, result, *t);
                            assert!(
                                x.mu >= p.mu_min
                                    && x.mu <= p.mu_max
                                    && y.mu >= p.mu_min
                                    && y.mu <= p.mu_max,
                            );
                            assert!(
                                x.phi >= p.min_phi
                                    && x.phi <= p.phi0
                                    && y.phi >= p.min_phi
                                    && y.phi <= p.phi0,
                            );
                            assert!(q >= 0 && q <= ONE);
                            assert!(x.last >= *last && x.last >= *t);
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn update_states_is_update_without_p() {
    let p = test_pool();
    let players = array![
        math::start::<TestRules>(BLITZ, 1).unwrap(), math::start::<TestRules>(BLITZ, 3).unwrap(),
        Rating { mu: ONE / 3, phi: ONE / 3, last: T0 },
        Rating { mu: -ONE, phi: ONE / 2, last: T0 - 200 * DAY },
        Rating { mu: 4 * ONE, phi: p.min_phi, last: T0 - DAY },
    ];
    for pool in array![BLITZ, RAPID] {
        for a in players.span() {
            for b in players.span() {
                for result in 0..3_u8 {
                    let (x, y, q) = math::update::<TestRules>(pool, @p, *a, *b, result, T0);
                    let states = math::update_states::<TestRules>(pool, @p, *a, *b, result, T0);
                    assert_eq!(states, (x, y));
                    assert!(q >= 0 && q <= ONE);
                }
            }
        }
    }
}

#[test]
fn a_player_losing_on_purpose_keeps_losing_down_to_the_floor() {
    // The floor sits below every band and anchor: until it, every loss costs
    // μ; then μ holds there.
    let p = test_pool();
    assert!(p.mu_min < p.anchor_mu_min);
    assert!(p.mu_min < math::start::<TestRules>(BLITZ, 1).unwrap().mu);
    let mut player = math::start::<TestRules>(BLITZ, 1).unwrap();
    let mut t = T0;
    let mut games = 0_u32;
    while player.mu > p.mu_min {
        assert!(games < 100);
        let opponent = Rating { mu: player.mu, phi: ONE / 2, last: t };
        let (after, _) = math::update_states::<TestRules>(BLITZ, @p, player, opponent, 0, t);
        assert!(after.mu < player.mu && after.mu >= p.mu_min);
        player = after;
        t += 30 * DAY;
        games += 1;
    }
    let opponent = Rating { mu: p.mu_min, phi: ONE / 2, last: t };
    let (after, _) = math::update_states::<TestRules>(BLITZ, @p, player, opponent, 0, t);
    assert_eq!(after.mu, p.mu_min);
}

#[test]
fn provisional() {
    let p = test_pool();
    assert!(!math::provisional(@p, ONE, 1, 1));
    assert!(math::provisional(@p, ONE + 1, 1, 1));
    assert!(math::provisional(@p, ONE / 2, 3, 0));
    assert!(math::provisional(@p, ONE / 2, 0, 3));
}

#[test]
fn aging_uses_the_pools_drift() {
    let p = test_pool();
    let player = Rating { mu: 0, phi: ONE / 2, last: T0 };
    let t = T0 + 30 * DAY;
    let blitz = math::aged_phi::<TestRules>(BLITZ, @p, player, t);
    let rapid = math::aged_phi::<TestRules>(RAPID, @p, player, t);
    // The same idle month ages a blitz player more: its half-life is shorter.
    assert!(blitz > rapid && rapid > player.phi && blitz < p.phi0);
    let idle: i128 = (30 * DAY).into();
    let c = drift_of(30 * ONE);
    assert_eq!(blitz, math::sqrt(player.phi * player.phi + math::div(c * c * idle, DAY.into())));
    let c = drift_of(60 * ONE);
    assert_eq!(rapid, math::sqrt(player.phi * player.phi + math::div(c * c * idle, DAY.into())));
    // `age` keeps μ and moves the clock.
    assert_eq!(math::age::<TestRules>(BLITZ, @p, player, t), Rating { mu: 0, phi: blitz, last: t });
    // No time, no aging; years idle cap at φ0 in either pool.
    assert_eq!(math::aged_phi::<TestRules>(BLITZ, @p, player, T0), player.phi);
    assert_eq!(math::aged_phi::<TestRules>(BLITZ, @p, player, T0 - DAY), player.phi);
    let years = T0 + 20 * 365 * DAY;
    assert_eq!(math::aged_phi::<TestRules>(BLITZ, @p, player, years), p.phi0);
    assert_eq!(math::aged_phi::<TestRules>(RAPID, @p, player, years), p.phi0);
    // A player never rated brings φ0.
    let new = math::start::<TestRules>(BLITZ, 3).unwrap();
    assert_eq!(math::aged_phi::<TestRules>(BLITZ, @p, new, t), p.phi0);
}

#[test]
fn an_idle_player_unsettles_sooner_in_the_faster_pool() {
    let p = test_pool();
    let player = Rating { mu: 0, phi: ONE * 9 / 10, last: T0 };
    assert!(math::settled::<TestRules>(BLITZ, @p, player, 10, T0));
    assert!(!math::settled::<TestRules>(BLITZ, @p, player, 9, T0));
    let t = T0 + 100 * DAY;
    assert!(math::aged_phi::<TestRules>(BLITZ, @p, player, t) > p.provisional_phi);
    assert!(math::aged_phi::<TestRules>(RAPID, @p, player, t) <= p.provisional_phi);
    assert!(!math::settled::<TestRules>(BLITZ, @p, player, 10, t));
    assert!(math::settled::<TestRules>(RAPID, @p, player, 10, t));
}

#[test]
fn the_same_game_after_the_same_idle_spell_moves_blitz_more() {
    let p = test_pool();
    let a = Rating { mu: 0, phi: ONE / 2, last: T0 };
    let t = T0 + 30 * DAY;
    let (blitz, _) = math::update_states::<TestRules>(BLITZ, @p, a, a, 2, t);
    let (rapid, _) = math::update_states::<TestRules>(RAPID, @p, a, a, 2, t);
    assert!(blitz.mu > rapid.mu && rapid.mu > a.mu);
}
