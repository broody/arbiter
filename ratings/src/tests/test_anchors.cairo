use starknet::ContractAddress;
use starknet::testing::{set_block_timestamp, set_contract_address};
use crate::math::{self, Rating};
use crate::ratings::{
    IRatingsDispatcher, IRatingsDispatcherTrait, QUEUE, RATED, TIMELOCK_SECONDS, VOID, admin_op,
};
use crate::rules::{BIAS_40, elo};
use crate::tests::rules::{BLITZ, TestRules, test_pool};
use crate::ticket::Ticket;
use super::test_ratings::{
    T0, accept, alice, bob, channel, digest_at, drain, owner, rating, result, settle_both, setup,
    start, ticket_for, updates,
};

/// μ at 1800 and at 2400 Elo, bands 4 and 7's.
const MU_1800: i64 = 7417145753;
const MU_2400: i64 = 22251437259;

fn ai() -> ContractAddress {
    'ai'.try_into().unwrap()
}

fn pin(ratings: IRatingsDispatcher, player: ContractAddress, mu: i64) {
    set_contract_address(owner());
    ratings.set_anchor(BLITZ, player, mu);
    set_contract_address(channel());
}

/// A ticket for game `id` at `t` between `player` and the anchor, which has no
/// band.
fn against_ai(id: felt252, t: u64, player: ContractAddress) -> Ticket {
    Ticket { band_1: 0, ..ticket_for(id, t, player, ai(), QUEUE) }
}

fn anchor_phi() -> i128 {
    test_pool().anchor_phi
}

#[test]
fn an_anchor_rates_only_its_opponent() {
    let ratings = setup();
    pin(ratings, ai(), MU_1800);
    let t = T0 + 3600;
    let ticket = accept(ratings, against_ai(1, t, alice()), 1);
    let (a, b) = ratings.rate_game(ticket, result(1, t, 1)).unwrap();
    let anchor = Rating { mu: MU_1800.into(), phi: anchor_phi(), last: t };
    let (expected, _) = math::update_states::<
        TestRules,
    >(BLITZ, @test_pool(), start(3), anchor, 2, t);
    assert_eq!(rating(ratings, alice()), expected);
    assert_eq!((a.games, a.wins, a.band), (1, 1, 3));
    assert!(!a.anchor);
    // The anchor is unchanged and never stored: no games, a firm rank.
    assert_eq!((b.mu, b.phi.into(), b.games), (MU_1800, anchor_phi(), 0));
    assert!(b.anchor && !b.provisional && b.established && !b.settled);
    assert_eq!(ratings.anchor(BLITZ, ai()), Option::Some(MU_1800));
    assert_eq!(ratings.ticket_status(digest_at(ratings, @ticket)), (RATED, 1));
}

#[test]
fn an_anchor_never_ages() {
    let ratings = setup();
    pin(ratings, ai(), MU_1800);
    let mut prev = start(3);
    let mut t = T0 + 3600;
    for id in 1..4_u32 {
        let id: felt252 = id.into();
        let ticket = accept(ratings, against_ai(id, t, alice()), id);
        ratings.rate_game(ticket, result(id, t, 2)).unwrap();
        let anchor = Rating { mu: MU_1800.into(), phi: anchor_phi(), last: t };
        let (expected, _) = math::update_states::<
            TestRules,
        >(BLITZ, @test_pool(), prev, anchor, 0, t);
        assert_eq!(rating(ratings, alice()), expected);
        prev = expected;
        t += 400 * 86400;
    }
    let view = ratings.player(BLITZ, ai());
    assert_eq!((view.mu, view.phi.into()), (MU_1800, anchor_phi()));
}

#[test]
fn an_anchors_events_show_its_pin_unchanged() {
    let ratings = setup();
    pin(ratings, ai(), MU_1800);
    let t = T0 + 3600;
    let ticket = accept(ratings, against_ai(1, t, alice()), 1);
    drain(ratings);
    ratings.rate_game(ticket, result(1, t, 2)).unwrap();
    let mut events = updates(ratings);
    let human = events.pop_front().unwrap();
    let anchor = events.pop_front().unwrap();
    assert!(human.applied && !human.anchor);
    assert_eq!((anchor.player, anchor.pool, anchor.score, anchor.band), (ai(), BLITZ, 2, 0));
    assert!(!anchor.applied && anchor.anchor);
    assert_eq!((anchor.pre_mu, anchor.pre_phi.into(), anchor.pre_last), (MU_1800, anchor_phi(), t));
    assert_eq!((anchor.mu, anchor.phi.into(), anchor.last_played), (MU_1800, anchor_phi(), t));
    assert_eq!(anchor.shown, 1800);
}

#[test]
fn ranks_show_an_anchor_firm() {
    let ratings = setup();
    pin(ratings, ai(), MU_2400);
    let ranks = ratings.ranks(BLITZ, array![ai(), alice()].span());
    assert_eq!(*ranks.at(0), (2400, false, true));
    assert_eq!(*ranks.at(1), (0, true, false));
}

#[test]
fn anchor_games_move_no_peak() {
    let ratings = setup();
    let next = settle_both(ratings, alice(), bob(), 14);
    pin(ratings, ai(), MU_2400);
    let before = ratings.player(BLITZ, alice());
    assert!(before.settled);
    let t = T0 + 20 * 3600;
    let ticket = accept(
        ratings, Ticket { band_1: 0, ..ticket_for(next, t, alice(), ai(), QUEUE) }, next,
    );
    let (a, _) = ratings.rate_game(ticket, result(next, t, 1)).unwrap();
    assert!(a.mu > before.mu);
    assert_eq!((a.peak, a.has_peak), (before.peak, before.has_peak));
}

#[test]
#[should_panic(expected: ('Anchor has a band', 'ENTRYPOINT_FAILED'))]
fn an_anchors_ticket_has_no_band() {
    let ratings = setup();
    pin(ratings, ai(), MU_1800);
    accept(ratings, ticket_for(1, T0 + 3600, alice(), ai(), QUEUE), 1);
}

#[test]
#[should_panic(expected: ('Two anchors', 'ENTRYPOINT_FAILED'))]
fn two_anchors_never_play_rated() {
    let ratings = setup();
    pin(ratings, ai(), MU_1800);
    pin(ratings, alice(), MU_2400);
    accept(ratings, Ticket { band_0: 0, ..against_ai(1, T0 + 3600, alice()) }, 1);
}

#[test]
#[should_panic(expected: ('Player is rated', 'ENTRYPOINT_FAILED'))]
fn a_rated_player_cannot_become_an_anchor() {
    let ratings = setup();
    settle_both(ratings, alice(), bob(), 1);
    pin(ratings, alice(), MU_1800);
}

#[test]
#[should_panic(expected: ('Invalid anchor rating', 'ENTRYPOINT_FAILED'))]
fn an_anchor_is_pinned_within_the_pools_range() {
    let ratings = setup();
    let top: i64 = test_pool().anchor_mu_max.try_into().unwrap();
    pin(ratings, ai(), top);
    pin(ratings, ai(), top + 1);
}

#[test]
#[should_panic(expected: ('Invalid anchor rating', 'ENTRYPOINT_FAILED'))]
fn an_anchor_is_pinned_above_the_pools_floor() {
    let ratings = setup();
    let bottom: i64 = test_pool().anchor_mu_min.try_into().unwrap();
    pin(ratings, ai(), bottom);
    pin(ratings, ai(), bottom - 1);
}

#[test]
fn removing_an_anchor_voids_its_unrated_games() {
    let ratings = setup();
    pin(ratings, ai(), MU_1800);
    let t = T0 + 3600;
    let ticket = accept(ratings, against_ai(1, t, alice()), 1);
    set_contract_address(owner());
    ratings.remove_anchor(BLITZ, ai());
    assert_eq!(ratings.anchor(BLITZ, ai()), Option::None);
    set_contract_address(channel());
    assert!(ratings.rate_game(ticket, result(1, t, 1)).is_none());
    assert_eq!(ratings.ticket_status(digest_at(ratings, @ticket)), (VOID, 1));
    assert_eq!(ratings.player(BLITZ, alice()).games, 0);
}

#[test]
#[should_panic(expected: ('Not queued', 'ENTRYPOINT_FAILED'))]
fn after_sealing_an_anchor_waits_for_the_timelock() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    ratings.set_anchor(BLITZ, ai(), MU_1800);
}

#[test]
fn after_sealing_anchors_are_queued_and_removed_at_once() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    let pinned: felt252 = (MU_1800.into() + BIAS_40).try_into().unwrap();
    ratings.queue(admin_op::<TestRules>('set_anchor', array![BLITZ, ai().into(), pinned].span()));
    set_block_timestamp(T0 + TIMELOCK_SECONDS);
    ratings.set_anchor(BLITZ, ai(), MU_1800);
    assert_eq!(ratings.anchor(BLITZ, ai()), Option::Some(MU_1800));
    // Removing trusts less: no wait.
    ratings.remove_anchor(BLITZ, ai());
    assert_eq!(ratings.anchor(BLITZ, ai()), Option::None);
}

#[test]
fn an_anchor_shows_its_pin_with_the_offset() {
    let ratings = setup();
    pin(ratings, ai(), MU_2400);
    set_contract_address(owner());
    ratings.set_rank_offset(BLITZ, -100);
    assert_eq!(ratings.player(BLITZ, ai()).shown, elo(MU_2400.into(), -100));
    assert_eq!(ratings.player(BLITZ, ai()).shown, 2300);
}
