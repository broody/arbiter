use arbiter::clocks::{Standard, encode};
use arbiter_testing::sign;
use core::poseidon::poseidon_hash_span;
use starknet::syscalls::deploy_syscall;
use starknet::testing::{set_block_timestamp, set_contract_address};
use starknet::{ContractAddress, SyscallResultTrait};
use crate::math::{self, ONE};
use crate::ratings::{
    CHANNEL_ACTIVE, IRatingsDispatcher, IRatingsDispatcherTrait, QUEUE, TIMELOCK_SECONDS, admin_op,
};
use crate::rules::{BIAS_40, PHI_LIMIT, Pool, elo, valid_pool};
use crate::tests::bad::{BAD, BadRatings, BadRules};
use crate::tests::contract::TestRatings;
use crate::tests::rules::{BLITZ, RAPID, TestRules, test_pool};
use crate::ticket::{Ticket, digest};
use super::test_ratings::{
    ALL_BANDS, CONFIG, PK_MATCHMAKER, T0, accept, alice, bob, channel, digest_at, owner, play,
    rating, result, setup, setup_salted, start, ticket_for,
};

#[test]
fn a_test_contract_deploys_with_its_rules() {
    let owner: ContractAddress = 'owner'.try_into().unwrap();
    let (address, _) = deploy_syscall(
        TestRatings::TEST_CLASS_HASH, 0, array![owner.into()].span(), false,
    )
        .unwrap_syscall();
    let ratings = IRatingsDispatcher { contract_address: address };
    assert_eq!(ratings.rules(), ('TEST', 1, false));
    assert_eq!(ratings.pool(BLITZ), Option::Some(test_pool()));
    assert!(ratings.pool('bullet').is_none());
    assert_eq!(ratings.owner(), owner);
}

// ---- valid_pool and elo ----

#[test]
fn every_test_pool_is_valid() {
    let p = test_pool();
    assert!(valid_pool(@p));
    for pool in array![BLITZ, RAPID] {
        assert!(valid_pool(@TestRules::pool(pool).unwrap()));
    }
    // Each bound, at its edge.
    assert!(valid_pool(@Pool { phi0: PHI_LIMIT - 1, ..p }));
    assert!(valid_pool(@Pool { mu_max: BIAS_40 - 1, ..p }));
    assert!(valid_pool(@Pool { mu_min: -BIAS_40 + 2 * p.phi0, ..p }));
    assert!(valid_pool(@Pool { min_phi: 1, ..p }));
    assert!(valid_pool(@Pool { anchor_mu_min: p.mu_min, anchor_mu_max: p.mu_max, ..p }));
    assert!(valid_pool(@Pool { max_offset: 0, ..p }));
}

#[test]
fn valid_pool_rejects_each_bound() {
    let p = test_pool();
    // Deviations are stored below 4.
    assert!(!valid_pool(@Pool { phi0: PHI_LIMIT, ..p }));
    assert!(!valid_pool(@Pool { anchor_phi: PHI_LIMIT, ..p }));
    // μ, and a peak μ − 2φ, stay within ±2^39.
    assert!(!valid_pool(@Pool { mu_max: BIAS_40, ..p }));
    assert!(!valid_pool(@Pool { mu_min: -BIAS_40 + 2 * p.phi0 - 1, ..p }));
    // A rated φ is never zero.
    assert!(!valid_pool(@Pool { min_phi: 0, ..p }));
    // Anchors are pinned within the pool's μ range.
    assert!(!valid_pool(@Pool { anchor_mu_min: p.mu_min - 1, ..p }));
    assert!(!valid_pool(@Pool { anchor_mu_max: p.mu_max + 1, ..p }));
    assert!(!valid_pool(@Pool { max_offset: -1, ..p }));
    // And the constants are in order.
    assert!(!valid_pool(@Pool { min_phi: p.provisional_phi + 1, ..p }));
    assert!(!valid_pool(@Pool { provisional_phi: p.phi0 + 1, ..p }));
    assert!(!valid_pool(@Pool { anchor_phi: p.min_phi - 1, ..p }));
    assert!(!valid_pool(@Pool { anchor_mu_min: p.anchor_mu_max + 1, ..p }));
    assert!(!valid_pool(@Pool { mu_min: 0, mu_max: 0, anchor_mu_min: 0, anchor_mu_max: 0, ..p }));
}

#[test]
fn elo_rounds_half_to_even() {
    assert_eq!(elo(0, 0), 1500);
    // 1508.5, 1491.5, 1791.5 and 1208.5, each with its neighbors.
    assert_eq!((elo(210152462, 0), elo(210152463, 0), elo(210152464, 0)), (1508, 1508, 1509));
    assert_eq!((elo(-210152464, 0), elo(-210152463, 0), elo(-210152462, 0)), (1491, 1492, 1492));
    assert_eq!((elo(7206993289, 0), elo(7206993290, 0), elo(7206993291, 0)), (1791, 1792, 1792));
    assert_eq!((elo(-7206993291, 0), elo(-7206993290, 0), elo(-7206993289, 0)), (1208, 1208, 1209));
}

#[test]
fn elo_applies_the_offset_before_the_clamp() {
    // 1500 − 1737.178 = −237, and 1500 + 64275.6 = 65776.
    assert_eq!(elo(-10 * ONE, 0), 0);
    assert_eq!(elo(-10 * ONE, 400), 163);
    assert_eq!(elo(370 * ONE, 0), 65535);
    assert_eq!(elo(370 * ONE, -400), 65376);
    assert_eq!(elo(0, -400), 1100);
}

#[test]
fn elo_clamps_to_sixteen_bits() {
    assert_eq!(elo(-200 * ONE, 400), 0);
    assert_eq!(elo(-BIAS_40, 400), 0);
    assert_eq!(elo(1000 * ONE, 0), 65535);
    assert_eq!(elo(BIAS_40 - 1, -400), 23336);
}

// ---- Pools ----

/// A rapid ticket for game `id` at `t`.
fn rapid(id: felt252, t: u64, player_0: ContractAddress, player_1: ContractAddress) -> Ticket {
    Ticket { pool: RAPID, ..ticket_for(id, t, player_0, player_1, QUEUE) }
}

/// Seconds after `T0` for game `id`, as `play` dates it.
fn time_of(id: felt252) -> u64 {
    T0 + id.try_into().unwrap() * 3600
}

#[test]
fn a_game_in_one_pool_leaves_the_other_unrated() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    let (a, _) = ratings.rate_game(ticket, game).unwrap();
    assert_eq!(a.games, 1);
    let nobody: ContractAddress = 'nobody'.try_into().unwrap();
    assert_eq!(ratings.player(RAPID, alice()), ratings.player(RAPID, nobody));
    assert_eq!(*ratings.ranks(RAPID, array![alice()].span())[0], (0, true, false));
    // A rapid game starts both from their bands, and leaves blitz alone.
    let blitz = rating(ratings, alice());
    let t = time_of(2);
    let ticket = accept(ratings, rapid(2, t, alice(), bob()), 2);
    let (a, b) = ratings.rate_game(ticket, result(2, t, 2)).unwrap();
    let (ea, eb) = math::update_states::<TestRules>(RAPID, @test_pool(), start(3), start(2), 0, t);
    assert_eq!((a.mu.into(), a.phi.into(), a.last_played), (ea.mu, ea.phi, ea.last));
    assert_eq!((b.mu.into(), b.phi.into(), b.last_played), (eb.mu, eb.phi, eb.last));
    assert_eq!((a.games, a.losses, a.band), (1, 1, 3));
    assert_eq!(rating(ratings, alice()), blitz);
    assert_eq!(ratings.player(BLITZ, alice()).wins, 1);
}

#[test]
fn offsets_are_per_pool() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    ratings.rate_game(ticket, game).unwrap();
    let t = time_of(2);
    let ticket = accept(ratings, rapid(2, t, alice(), bob()), 2);
    ratings.rate_game(ticket, result(2, t, 1)).unwrap();
    set_contract_address(owner());
    ratings.set_rank_offset(BLITZ, 100);
    assert_eq!((ratings.rank_offset(BLITZ), ratings.rank_offset(RAPID)), (100, 0));
    let blitz = ratings.player(BLITZ, alice());
    let rapid = ratings.player(RAPID, alice());
    assert_eq!(blitz.shown, elo(blitz.mu.into(), 100));
    assert_eq!(rapid.shown, elo(rapid.mu.into(), 0));
}

#[test]
#[should_panic(expected: ('Band not allowed', 'ENTRYPOINT_FAILED'))]
fn start_bands_are_per_pool() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    ratings.rate_game(ticket, game).unwrap();
    set_contract_address(owner());
    ratings.set_start_bands(RAPID, 0b10);
    assert_eq!((ratings.start_bands(BLITZ), ratings.start_bands(RAPID)), (ALL_BANDS, 0b10));
    // Rated in blitz, alice is new in rapid: her band must be allowed there.
    accept(ratings, rapid(2, time_of(2), alice(), bob()), 2);
}

#[test]
fn anchors_are_per_pool() {
    let ratings = setup();
    let ai: ContractAddress = 'ai'.try_into().unwrap();
    // Rated in rapid, alice can still be pinned in blitz.
    let t = time_of(1);
    let ticket = accept(ratings, rapid(1, t, alice(), bob()), 1);
    ratings.rate_game(ticket, result(1, t, 1)).unwrap();
    set_contract_address(owner());
    ratings.set_anchor(BLITZ, alice(), 7417145753);
    ratings.set_anchor(BLITZ, ai, 7417145753);
    ratings.set_anchor(RAPID, ai, 22251437259);
    assert_eq!(ratings.anchor(BLITZ, alice()), Option::Some(7417145753));
    assert_eq!(ratings.anchor(RAPID, alice()), Option::None);
    assert!(ratings.player(BLITZ, alice()).anchor && !ratings.player(RAPID, alice()).anchor);
    assert_eq!(ratings.player(BLITZ, ai).shown, 1800);
    assert_eq!(ratings.player(RAPID, ai).shown, 2400);
    ratings.remove_anchor(BLITZ, ai);
    assert_eq!(ratings.anchor(BLITZ, ai), Option::None);
    assert_eq!(ratings.anchor(RAPID, ai), Option::Some(22251437259));
}

#[test]
fn an_anchor_in_one_pool_is_a_player_in_another() {
    let ratings = setup();
    let ai: ContractAddress = 'ai'.try_into().unwrap();
    set_contract_address(owner());
    ratings.set_anchor(BLITZ, ai, 7417145753);
    // In rapid it chooses a band and its games rate it.
    let t = time_of(1);
    let ticket = accept(ratings, rapid(1, t, alice(), ai), 1);
    let (_, b) = ratings.rate_game(ticket, result(1, t, 2)).unwrap();
    assert!(!b.anchor);
    assert_eq!((b.games, b.wins, b.band), (1, 1, 2));
    assert_eq!(ratings.anchor(BLITZ, ai), Option::Some(7417145753));
}

#[test]
#[should_panic(expected: ('Config not allowed', 'ENTRYPOINT_FAILED'))]
fn a_config_allowed_in_blitz_is_refused_in_rapid() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_config(BLITZ, 'blitz only', true);
    assert!(!ratings.is_config(RAPID, 'blitz only'));
    let t = time_of(1);
    accept(ratings, Ticket { config: 'blitz only', ..ticket_for(1, t, alice(), bob(), QUEUE) }, 1);
    accept(ratings, Ticket { config: 'blitz only', ..rapid(2, t, alice(), bob()) }, 2);
}

#[test]
#[should_panic(expected: ('Clock not allowed', 'ENTRYPOINT_FAILED'))]
fn a_clock_allowed_in_blitz_is_refused_in_rapid() {
    let ratings = setup();
    let bullet = encode(
        @Standard { turn_ms: 0, bank_ms: 60000, increment_ms: 0, byoyomi: Option::None },
    );
    set_contract_address(owner());
    ratings.set_clock_preset(BLITZ, bullet, true);
    assert!(!ratings.is_clock_preset(RAPID, bullet));
    let clock = poseidon_hash_span(bullet);
    let t = time_of(1);
    accept(ratings, Ticket { clock, ..ticket_for(1, t, alice(), bob(), QUEUE) }, 1);
    accept(ratings, Ticket { clock, ..rapid(2, t, alice(), bob()) }, 2);
}

#[test]
#[should_panic(expected: ('Unknown pool', 'ENTRYPOINT_FAILED'))]
fn an_unknown_pool_takes_no_tickets() {
    let ratings = setup();
    accept(
        ratings, Ticket { pool: 'bullet', ..ticket_for(1, time_of(1), alice(), bob(), QUEUE) }, 1,
    );
}

#[test]
#[should_panic(expected: ('Unknown pool', 'ENTRYPOINT_FAILED'))]
fn an_unknown_pool_has_no_players() {
    let ratings = setup();
    ratings.player('bullet', alice());
}

#[test]
#[should_panic(expected: ('Unknown pool', 'ENTRYPOINT_FAILED'))]
fn an_unknown_pool_has_no_ranks() {
    let ratings = setup();
    ratings.ranks('bullet', array![alice()].span());
}

#[test]
#[should_panic(expected: ('Unknown pool', 'ENTRYPOINT_FAILED'))]
fn an_unknown_pool_takes_no_policy() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_config('bullet', CONFIG, true);
}

#[test]
#[should_panic(expected: ('Invalid pool', 'ENTRYPOINT_FAILED'))]
fn a_pool_outside_the_packing_bounds_takes_no_tickets() {
    let (address, _) = deploy_syscall(
        BadRatings::TEST_CLASS_HASH, 0, array![owner().into()].span(), false,
    )
        .unwrap_syscall();
    let ratings = IRatingsDispatcher { contract_address: address };
    assert!(!valid_pool(@ratings.pool(BAD).unwrap()));
    set_contract_address(owner());
    ratings.set_channel(channel(), CHANNEL_ACTIVE);
    set_contract_address(channel());
    set_block_timestamp(T0);
    let ticket = Ticket { pool: BAD, ..ticket_for(1, T0, alice(), bob(), QUEUE) };
    ratings.check_ticket(ticket, sign(digest::<BadRules>(@ticket, address), PK_MATCHMAKER), 1);
}

// ---- Bands ----

#[test]
fn bands_5_and_7_can_be_allowed() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_start_bands(BLITZ, 0b10100000);
    assert_eq!(ratings.start_bands(BLITZ), 0b10100000);
    let t = time_of(1);
    let ticket = accept(
        ratings, Ticket { band_0: 5, band_1: 7, ..ticket_for(1, t, alice(), bob(), QUEUE) }, 1,
    );
    let (a, b) = ratings.rate_game(ticket, result(1, t, 0)).unwrap();
    let (ea, eb) = math::update_states::<TestRules>(BLITZ, @test_pool(), start(5), start(7), 1, t);
    assert_eq!(rating(ratings, alice()), ea);
    assert_eq!(rating(ratings, bob()), eb);
    assert_eq!((a.band, b.band, a.draws, b.draws), (5, 7, 1, 1));
}

#[test]
#[should_panic(expected: ('Invalid bands', 'ENTRYPOINT_FAILED'))]
fn band_6_is_never_allowed() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_start_bands(BLITZ, 0b1000000);
}

#[test]
#[should_panic(expected: ('Invalid bands', 'ENTRYPOINT_FAILED'))]
fn there_is_no_band_0() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_start_bands(BLITZ, 0b1);
}

#[test]
#[should_panic(expected: ('Invalid band', 'ENTRYPOINT_FAILED'))]
fn a_ticket_cannot_name_band_6() {
    let ratings = setup();
    accept(ratings, Ticket { band_1: 6, ..ticket_for(1, time_of(1), alice(), bob(), QUEUE) }, 1);
}

// ---- Seats ----

#[test]
#[should_panic(expected: ('Invalid players', 'ENTRYPOINT_FAILED'))]
fn seat_0_must_be_taken() {
    let ratings = setup();
    let zero: ContractAddress = 0.try_into().unwrap();
    accept(ratings, ticket_for(1, time_of(1), zero, bob(), QUEUE), 1);
}

#[test]
#[should_panic(expected: ('Invalid players', 'ENTRYPOINT_FAILED'))]
fn seat_1_must_be_taken() {
    let ratings = setup();
    let zero: ContractAddress = 0.try_into().unwrap();
    accept(ratings, ticket_for(1, time_of(1), alice(), zero, QUEUE), 1);
}

#[test]
#[should_panic(expected: ('Invalid players', 'ENTRYPOINT_FAILED'))]
fn a_player_cannot_take_both_seats() {
    let ratings = setup();
    accept(ratings, ticket_for(1, time_of(1), alice(), alice(), QUEUE), 1);
}

// ---- Deployments ----

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn a_ticket_is_signed_for_one_deployment() {
    let first = setup();
    let second = setup_salted(1);
    let ticket = ticket_for(1, time_of(1), alice(), bob(), QUEUE);
    assert_ne!(digest_at(first, @ticket), digest_at(second, @ticket));
    let signature = sign(digest_at(first, @ticket), PK_MATCHMAKER);
    set_contract_address(channel());
    first.check_ticket(ticket, signature, 1);
    second.check_ticket(ticket, signature, 1);
}

// ---- Administration ----

#[test]
fn the_rank_offset_is_bounded_by_the_pool() {
    let ratings = setup();
    let max = test_pool().max_offset;
    set_contract_address(owner());
    ratings.set_rank_offset(BLITZ, max);
    assert_eq!(ratings.rank_offset(BLITZ), 400);
    ratings.set_rank_offset(BLITZ, -max);
    assert_eq!(ratings.rank_offset(BLITZ), -400);
}

#[test]
#[should_panic(expected: ('Invalid offset', 'ENTRYPOINT_FAILED'))]
fn the_rank_offset_stays_below_the_pools_bound() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_rank_offset(BLITZ, test_pool().max_offset + 1);
}

#[test]
#[should_panic(expected: ('Invalid offset', 'ENTRYPOINT_FAILED'))]
fn the_rank_offset_stays_above_the_pools_bound() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_rank_offset(BLITZ, -test_pool().max_offset - 1);
}

#[test]
fn queued_changes_name_the_rules_and_the_pool() {
    let ratings = setup();
    let ai: ContractAddress = 'ai'.try_into().unwrap();
    let bullet = encode(
        @Standard { turn_ms: 0, bank_ms: 60000, increment_ms: 0, byoyomi: Option::None },
    );
    let args = array![BLITZ, 'new config'].span();
    assert_ne!(admin_op::<TestRules>('set_config', args), admin_op::<BadRules>('set_config', args));
    set_contract_address(owner());
    ratings.set_start_bands(RAPID, 0b10);
    ratings.seal();
    let pin: felt252 = (22251437259 + BIAS_40).try_into().unwrap();
    let ops = array![
        admin_op::<TestRules>('set_config', array![RAPID, 'new config'].span()),
        admin_op::<TestRules>('set_clock_preset', array![RAPID, poseidon_hash_span(bullet)].span()),
        admin_op::<TestRules>('set_start_bands', array![RAPID, 0b110].span()),
        admin_op::<TestRules>('set_rank_offset', array![RAPID, 0x80000000 - 25].span()),
        admin_op::<TestRules>('set_anchor', array![RAPID, ai.into(), pin].span()),
    ];
    for op in ops.span() {
        ratings.queue(*op);
    }
    set_block_timestamp(T0 + TIMELOCK_SECONDS);
    ratings.set_config(RAPID, 'new config', true);
    ratings.set_clock_preset(RAPID, bullet, true);
    ratings.set_start_bands(RAPID, 0b110);
    ratings.set_rank_offset(RAPID, -25);
    ratings.set_anchor(RAPID, ai, 22251437259);
    for op in ops.span() {
        assert_eq!(ratings.queued(*op), 0);
    }
    assert!(ratings.is_config(RAPID, 'new config') && ratings.is_clock_preset(RAPID, bullet));
    assert_eq!((ratings.start_bands(RAPID), ratings.rank_offset(RAPID)), (0b110, -25));
    assert_eq!(ratings.anchor(RAPID, ai), Option::Some(22251437259));
    // Blitz's policy didn't move.
    assert!(!ratings.is_config(BLITZ, 'new config') && !ratings.is_clock_preset(BLITZ, bullet));
    assert_eq!((ratings.start_bands(BLITZ), ratings.rank_offset(BLITZ)), (ALL_BANDS, 0));
    assert_eq!(ratings.anchor(BLITZ, ai), Option::None);
}

#[test]
#[should_panic(expected: ('Not queued', 'ENTRYPOINT_FAILED'))]
fn a_change_queued_under_another_games_tag_never_applies() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    ratings.queue(admin_op::<BadRules>('set_config', array![BLITZ, 'new config'].span()));
    set_block_timestamp(T0 + TIMELOCK_SECONDS);
    ratings.set_config(BLITZ, 'new config', true);
}

#[test]
#[should_panic(expected: ('Not queued', 'ENTRYPOINT_FAILED'))]
fn a_change_queued_for_one_pool_never_applies_to_another() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    ratings.queue(admin_op::<TestRules>('set_config', array![BLITZ, 'new config'].span()));
    set_block_timestamp(T0 + TIMELOCK_SECONDS);
    ratings.set_config(RAPID, 'new config', true);
}
