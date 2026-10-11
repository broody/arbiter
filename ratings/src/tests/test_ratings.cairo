use arbiter::clocks::{Standard, encode};
use arbiter::{REASON_RESIGN, REASON_TIMEOUT};
use arbiter_testing::{public_key, sign};
use core::poseidon::poseidon_hash_span;
use starknet::syscalls::deploy_syscall;
use starknet::testing::{pop_log, pop_log_raw, set_block_timestamp, set_contract_address};
use starknet::{ContractAddress, SyscallResultTrait, get_tx_info};
use crate::math::{self, ONE, Rating};
use crate::ratings::RatingsComponent::{Event as RatingsEvent, RatingUpdated};
use crate::ratings::{
    ACCEPTED, CHANNEL_ACTIVE, CHANNEL_RETIRING, GameResult, IRatingsDispatcher,
    IRatingsDispatcherTrait, MAX_CLOCK_SKEW, NONE, QUEUE, QUEUE_LIFE, RATED, TABLE,
    TIMELOCK_SECONDS, VOID, admin_op,
};
use crate::tests::contract::TestRatings;
use crate::tests::contract::TestRatings::Event;
use crate::tests::rules::{BLITZ, RAPID, TestRules, test_pool};
use crate::ticket::{Ticket, digest};

pub const PK_MATCHMAKER: felt252 = 0x3a7c4;
pub const PK_REFEREE: felt252 = 0x7e7e7e;
pub const T0: u64 = 1_700_000_000;
/// Every band a new player could choose: 1 to 5 and 7.
pub const ALL_BANDS: u8 = 0b10111110;
/// The hash of the game's rated config (`arbiter::config_hash`).
pub const CONFIG: felt252 = 'rated config';

pub fn owner() -> ContractAddress {
    'owner'.try_into().unwrap()
}

pub fn channel() -> ContractAddress {
    'channel'.try_into().unwrap()
}

pub fn prover() -> ContractAddress {
    'prover'.try_into().unwrap()
}

pub fn alice() -> ContractAddress {
    'alice'.try_into().unwrap()
}

pub fn bob() -> ContractAddress {
    'bob'.try_into().unwrap()
}

/// Three minutes a side, two seconds a move.
pub fn settings() -> Span<felt252> {
    encode(@Standard { turn_ms: 0, bank_ms: 180000, increment_ms: 2000, byoyomi: Option::None })
}

/// The hash a ticket carries for `settings()`.
pub fn clock() -> felt252 {
    poseidon_hash_span(settings())
}

pub fn deploy(salt: felt252) -> IRatingsDispatcher {
    let (address, _) = deploy_syscall(
        TestRatings::TEST_CLASS_HASH, salt, array![owner().into()].span(), false,
    )
        .unwrap_syscall();
    IRatingsDispatcher { contract_address: address }
}

/// A contract in its setup phase whose policy accepts `ticket_for`'s tickets
/// from `channel()`, in either pool, with every starting band allowed.
pub fn setup() -> IRatingsDispatcher {
    setup_salted(0)
}

pub fn setup_salted(salt: felt252) -> IRatingsDispatcher {
    let ratings = deploy(salt);
    set_block_timestamp(T0);
    set_contract_address(owner());
    ratings.set_channel(channel(), CHANNEL_ACTIVE);
    ratings.set_matchmaker(public_key(PK_MATCHMAKER));
    ratings.set_referee(public_key(PK_REFEREE));
    for pool in array![BLITZ, RAPID] {
        ratings.set_start_bands(pool, ALL_BANDS);
        ratings.set_config(pool, CONFIG, true);
        ratings.set_clock_preset(pool, settings(), true);
    }
    ratings.set_prover(prover(), true);
    ratings.set_response_window(300, 900);
    set_contract_address(channel());
    ratings
}

/// A blitz ticket for game `id` issued at `t`.
pub fn ticket_for(
    id: felt252, t: u64, player_0: ContractAddress, player_1: ContractAddress, source: u8,
) -> Ticket {
    Ticket {
        chain_id: get_tx_info().unbox().chain_id,
        channel: channel(),
        player_0,
        player_1,
        pool: BLITZ,
        config: CONFIG,
        referee: public_key(PK_REFEREE),
        clock: clock(),
        prover: prover(),
        response_seconds: 600,
        source,
        band_0: 3,
        band_1: 2,
        matchmaker: public_key(PK_MATCHMAKER),
        issued_at: t - 30,
        expires_at: t + 270,
        nonce: id,
    }
}

/// `ticket`'s digest at `ratings`.
pub fn digest_at(ratings: IRatingsDispatcher, ticket: @Ticket) -> felt252 {
    digest::<TestRules>(ticket, ratings.contract_address)
}

/// Accept `ticket` for game `id` as `channel()`, at its issue time.
pub fn accept(ratings: IRatingsDispatcher, ticket: Ticket, id: felt252) -> Ticket {
    set_block_timestamp(ticket.issued_at + 30);
    set_contract_address(channel());
    ratings.check_ticket(ticket, sign(digest_at(ratings, @ticket), PK_MATCHMAKER), id);
    ticket
}

/// The result of game `id` played at `t` and settled 10 minutes later, which
/// is when the channel reports it.
pub fn result(id: felt252, t: u64, winner: u8) -> GameResult {
    set_block_timestamp(t + 600);
    GameResult {
        game_id: id,
        winner,
        reason: 1,
        played_at: t,
        settled_at: t + 600,
        steps: 60,
        onchain_forfeit: false,
    }
}

/// Blitz game `id` between alice and bob, an hour after the last: accepted,
/// then reported with `winner`.
pub fn play(ratings: IRatingsDispatcher, id: felt252, winner: u8) -> (Ticket, GameResult) {
    let t = T0 + id.try_into().unwrap() * 3600;
    let ticket = accept(ratings, ticket_for(id, t, alice(), bob(), QUEUE), id);
    (ticket, result(id, t, winner))
}

/// A player's stored blitz rating.
pub fn rating(ratings: IRatingsDispatcher, player: ContractAddress) -> Rating {
    let p = ratings.player(BLITZ, player);
    Rating { mu: p.mu.into(), phi: p.phi.into(), last: p.last_played }
}

pub fn status(ratings: IRatingsDispatcher, ticket: @Ticket) -> u8 {
    let (status, _) = ratings.ticket_status(digest_at(ratings, ticket));
    status
}

pub fn start(band: u8) -> Rating {
    math::start::<TestRules>(BLITZ, band).unwrap()
}

/// Drop every event emitted so far.
pub fn drain(ratings: IRatingsDispatcher) {
    loop {
        match pop_log_raw(ratings.contract_address) {
            Option::Some(_) => {},
            Option::None => { break; },
        }
    }
}

/// The rating updates emitted since the last drain.
pub fn updates(ratings: IRatingsDispatcher) -> Array<RatingUpdated> {
    let mut events = array![];
    loop {
        match pop_log::<Event>(ratings.contract_address) {
            Option::Some(Event::RatingsEvent(RatingsEvent::RatingUpdated(e))) => events.append(e),
            Option::Some(_) => {},
            Option::None => { break; },
        }
    }
    events
}

#[test]
fn rates_a_game_like_the_math() {
    let ratings = setup();
    let p = test_pool();
    let (ticket, game) = play(ratings, 1, 1);
    assert_eq!(status(ratings, @ticket), ACCEPTED);
    let (a, b) = ratings.rate_game(ticket, game).unwrap();
    let (ea, eb) = math::update_states::<
        TestRules,
    >(BLITZ, @p, start(3), start(2), 2, game.played_at);
    assert_eq!(rating(ratings, alice()), ea);
    assert_eq!(rating(ratings, bob()), eb);
    assert_eq!((a.games, a.wins, a.losses, a.band, a.params), (1, 1, 0, 3, TestRules::VERSION));
    assert_eq!((b.games, b.wins, b.losses, b.band), (1, 0, 1, 2));
    assert!(a.provisional && b.provisional);
    assert_eq!(ratings.ticket_status(digest_at(ratings, @ticket)), (RATED, 1));

    // A second game starts from the stored ratings, not the bands.
    let (mut ticket, game) = play(ratings, 2, 2);
    ticket.band_0 = 1;
    let ticket = accept(ratings, ticket, 2);
    set_block_timestamp(game.settled_at);
    ratings.rate_game(ticket, game).unwrap();
    let (ea2, eb2) = math::update_states::<TestRules>(BLITZ, @p, ea, eb, 0, game.played_at);
    assert_eq!(rating(ratings, alice()), ea2);
    assert_eq!(rating(ratings, bob()), eb2);
    assert_eq!(ratings.player(BLITZ, alice()).band, 3);
}

#[test]
fn rates_each_ticket_once() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    assert!(ratings.rate_game(ticket, game).is_some());
    let before = ratings.player(BLITZ, alice());
    assert!(ratings.rate_game(ticket, GameResult { winner: 2, ..game }).is_none());
    assert_eq!(ratings.player(BLITZ, alice()), before);
}

#[test]
fn only_the_tickets_channel_rates_its_game() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    // Another active channel can't report this ticket's game...
    set_contract_address(owner());
    let other: ContractAddress = 'other'.try_into().unwrap();
    ratings.set_channel(other, CHANNEL_ACTIVE);
    set_contract_address(other);
    assert!(ratings.rate_game(ticket, game).is_none());
    // ...nor can a stranger.
    set_contract_address('stranger'.try_into().unwrap());
    assert!(ratings.rate_game(ticket, game).is_none());
    assert_eq!(status(ratings, @ticket), ACCEPTED);
}

#[test]
fn a_result_must_name_its_tickets_game() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    assert!(ratings.rate_game(ticket, GameResult { game_id: 2, ..game }).is_none());
    // A ticket that was never accepted rates nothing either.
    let changed = Ticket { nonce: 99, ..ticket };
    assert!(ratings.rate_game(changed, game).is_none());
    assert_eq!(ratings.player(BLITZ, alice()).games, 0);
}

#[test]
fn a_fresh_contract_cannot_rate_an_old_worlds_games() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    // A world pointed at another deployment: it has no accepted tickets.
    let fresh = setup_salted(1);
    set_contract_address(channel());
    assert!(fresh.rate_game(ticket, game).is_none());
    assert_eq!(fresh.player(BLITZ, alice()).games, 0);
}

#[test]
fn impossible_times_void_the_game() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    // Played after the join deadline, e.g. at u64::MAX.
    assert!(
        ratings.rate_game(ticket, GameResult { played_at: 0xffffffffffffffff, ..game }).is_none(),
    );
    assert_eq!(status(ratings, @ticket), VOID);
    let (ticket, game) = play(ratings, 2, 1);
    // Settled in the future.
    assert!(
        ratings.rate_game(ticket, GameResult { settled_at: game.settled_at + 1, ..game }).is_none(),
    );
    assert_eq!(status(ratings, @ticket), VOID);
    let (ticket, game) = play(ratings, 3, 1);
    assert!(ratings.rate_game(ticket, GameResult { winner: 3, ..game }).is_none());
    let (ticket, game) = play(ratings, 4, 1);
    assert!(ratings.rate_game(ticket, GameResult { reason: 131, ..game }).is_none());
    assert_eq!(ratings.player(BLITZ, alice()).games, 0);
}

#[test]
fn a_revoked_matchmaker_voids_games_played_from_then_on() {
    let ratings = setup();
    let (early, early_game) = play(ratings, 1, 1);
    let (late, late_game) = play(ratings, 2, 1);
    // Revoked from between the two games' join times.
    set_contract_address(owner());
    ratings.revoke_matchmaker(public_key(PK_MATCHMAKER), late_game.played_at);
    assert_eq!(ratings.matchmaker(public_key(PK_MATCHMAKER)), (2, late_game.played_at));
    set_contract_address(channel());
    assert!(ratings.rate_game(early, early_game).is_some());
    assert!(ratings.rate_game(late, late_game).is_none());
    assert_eq!(status(ratings, @late), VOID);
}

#[test]
#[should_panic(expected: ('Matchmaker not allowed', 'ENTRYPOINT_FAILED'))]
fn a_retired_matchmaker_signs_no_new_tickets() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    set_contract_address(owner());
    ratings.retire_matchmaker(public_key(PK_MATCHMAKER));
    // Its accepted game still rates: routine rotation voids nothing.
    set_contract_address(channel());
    assert!(ratings.rate_game(ticket, game).is_some());
    accept(ratings, ticket_for(2, T0 + 7200, alice(), bob(), QUEUE), 2);
}

#[test]
fn a_revoked_referee_voids_the_games_it_started_after_and_its_late_flags() {
    let ratings = setup();
    // Started an hour, two hours and three hours after T0, each settled 10
    // minutes after it started; the referee is revoked 2 h 5 min after T0.
    let (early, early_game) = play(ratings, 1, 1);
    let (flag, flag_game) = play(ratings, 2, 1);
    let (late, late_game) = play(ratings, 3, 1);
    set_contract_address(owner());
    ratings.revoke_referee(public_key(PK_REFEREE), T0 + 7500);
    set_contract_address(channel());
    // Its flag decided this timeout, settled after the revocation.
    assert!(ratings.rate_game(flag, GameResult { reason: REASON_TIMEOUT, ..flag_game }).is_none());
    assert_eq!(status(ratings, @flag), VOID);
    // Its first stamp dated this game, after the revocation: void however it ended.
    assert!(ratings.rate_game(late, GameResult { reason: REASON_RESIGN, ..late_game }).is_none());
    assert_eq!(status(ratings, @late), VOID);
    // Started and settled before it: the players' resignation stands.
    assert!(ratings.rate_game(early, GameResult { reason: REASON_RESIGN, ..early_game }).is_some());
}

#[test]
fn a_game_that_never_started_is_void() {
    // No referee stamp: nothing dates it within the ticket's window.
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    assert!(ratings.rate_game(ticket, GameResult { played_at: 0, ..game }).is_none());
    assert_eq!(status(ratings, @ticket), VOID);
}

#[test]
fn a_start_is_checked_against_the_tickets_window_up_to_the_clock_skew() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    // The referee's clock a minute behind the matchmaker's is still in the window.
    let skewed = GameResult { played_at: ticket.issued_at - MAX_CLOCK_SKEW, ..game };
    assert!(ratings.rate_game(ticket, skewed).is_some());
    let (ticket, game) = play(ratings, 2, 1);
    let early = GameResult { played_at: ticket.issued_at - MAX_CLOCK_SKEW - 1, ..game };
    assert!(ratings.rate_game(ticket, early).is_none());
    let (ticket, game) = play(ratings, 3, 1);
    let late = GameResult { played_at: ticket.expires_at + MAX_CLOCK_SKEW + 1, ..game };
    assert!(ratings.rate_game(ticket, late).is_none());
}

#[test]
fn a_short_game_is_void_unless_forfeited_onchain() {
    let ratings = setup();
    let min_steps = test_pool().min_steps;
    let (ticket, game) = play(ratings, 1, 1);
    assert!(ratings.rate_game(ticket, GameResult { steps: min_steps - 1, ..game }).is_none());
    assert_eq!(status(ratings, @ticket), VOID);
    // Resigned onchain before the keeper submitted: the anchor may be stale,
    // so the loser still loses, and the winner gains nothing.
    let (ticket, game) = play(ratings, 2, 2);
    let forfeit = GameResult { steps: 0, reason: REASON_RESIGN, onchain_forfeit: true, ..game };
    let (a, b) = ratings.rate_game(ticket, forfeit).unwrap();
    assert_eq!((a.games, a.losses), (1, 1));
    assert!(a.mu.into() < start(3).mu);
    assert_eq!(b.games, 0);
    assert_eq!(ratings.player(BLITZ, bob()), ratings.player(BLITZ, 'nobody'.try_into().unwrap()));
    // A short onchain draw can't happen, but would be void too.
    let (ticket, game) = play(ratings, 3, 0);
    let draw = GameResult { steps: 0, onchain_forfeit: true, ..game };
    assert!(ratings.rate_game(ticket, draw).is_none());
}

/// `n` blitz games at a queue between two fresh players, alternating results,
/// so both end settled. Returns the next game id.
pub fn settle_both(
    ratings: IRatingsDispatcher, a: ContractAddress, b: ContractAddress, n: u32,
) -> felt252 {
    let mut id: felt252 = 1;
    for i in 0..n {
        let t = T0 + i.into() * 3600;
        let ticket = accept(ratings, ticket_for(id, t, a, b, QUEUE), id);
        let _ = ratings.rate_game(ticket, result(id, t, if i % 2 == 0 {
            1
        } else {
            2
        }));
        id += 1;
    }
    id
}

#[test]
fn a_game_against_a_newcomer_counts_but_moves_no_peak() {
    let ratings = setup();
    let next = settle_both(ratings, alice(), bob(), 14);
    let settled = ratings.player(BLITZ, alice());
    assert!(settled.settled);
    let before = rating(ratings, alice());
    // A newcomer loses to alice at the queue: both ratings move, the peak doesn't.
    let newcomer: ContractAddress = 'newcomer'.try_into().unwrap();
    let t = T0 + 20 * 3600;
    let ticket = accept(ratings, ticket_for(next, t, alice(), newcomer, QUEUE), next);
    let (a, n) = ratings.rate_game(ticket, result(next, t, 1)).unwrap();
    let (expected, _) = math::update_states::<
        TestRules,
    >(BLITZ, @test_pool(), before, start(2), 2, t);
    assert_eq!(rating(ratings, alice()), expected);
    assert_eq!((a.games, a.wins), (settled.games + 1, settled.wins + 1));
    assert_eq!((a.peak, a.has_peak), (settled.peak, settled.has_peak));
    assert_eq!((n.games, n.losses), (1, 1));
}

#[test]
fn peak_moves_only_between_settled_players_at_the_queue() {
    let ratings = setup();
    let next = settle_both(ratings, alice(), bob(), 14);
    let before = ratings.player(BLITZ, alice());
    // Two settled players at a table: ratings move, the peak doesn't.
    let t = T0 + 20 * 3600;
    let ticket = accept(ratings, ticket_for(next, t, alice(), bob(), TABLE), next);
    let (a, _) = ratings.rate_game(ticket, result(next, t, 1)).unwrap();
    assert!(a.mu > before.mu);
    assert_eq!((a.peak, a.has_peak), (before.peak, before.has_peak));
    // At the queue it does.
    let t = t + 3600;
    let ticket = accept(ratings, ticket_for(next + 1, t, alice(), bob(), QUEUE), next + 1);
    let (a, _) = ratings.rate_game(ticket, result(next + 1, t, 1)).unwrap();
    assert!(a.has_peak && a.peak == a.mu - 2 * a.phi.try_into().unwrap());
}

#[test]
fn views_age_the_deviation() {
    let ratings = setup();
    settle_both(ratings, alice(), bob(), 14);
    let now = ratings.player(BLITZ, alice());
    assert!(!now.provisional && now.settled && now.established);
    // Three years idle: the rank shows "?" again, as the next game would see it.
    set_block_timestamp(T0 + 3 * 365 * 86400);
    let idle = ratings.player(BLITZ, alice());
    assert!(idle.provisional && !idle.settled && idle.established);
    assert_eq!(idle.phi, now.phi);
    let ranks = ratings.ranks(BLITZ, array![alice(), 'nobody'.try_into().unwrap()].span());
    assert_eq!(*ranks[0], (idle.shown, true, true));
    assert_eq!(*ranks[1], (0, true, false));
}

#[test]
fn a_late_game_never_moves_the_clock_back() {
    let ratings = setup();
    let (late, late_game) = play(ratings, 5, 1);
    let (early, early_game) = play(ratings, 2, 2);
    set_block_timestamp(late_game.settled_at);
    ratings.rate_game(late, late_game).unwrap();
    ratings.rate_game(early, early_game).unwrap();
    assert_eq!(ratings.player(BLITZ, alice()).last_played, late_game.played_at);
}

#[test]
fn events_carry_each_sides_state_before_and_after() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    // Drop the setup and ticket events.
    drain(ratings);
    ratings.rate_game(ticket, game).unwrap();
    let mut events = updates(ratings);
    assert_eq!(events.len(), 2);
    let e = events.pop_front().unwrap();
    let after = rating(ratings, alice());
    assert_eq!(
        (e.player, e.digest, e.pool, e.game_id), (alice(), digest_at(ratings, @ticket), BLITZ, 1),
    );
    assert_eq!((e.channel, e.opponent), (channel(), bob()));
    assert_eq!(
        (e.score, e.source, e.steps, e.params, e.band, e.applied),
        (2, QUEUE, 60, TestRules::VERSION, 3, true),
    );
    assert_eq!((e.pre_mu.into(), e.pre_phi), (start(3).mu, 0));
    assert_eq!((e.mu.into(), e.phi.into(), e.last_played), (after.mu, after.phi, after.last));
    assert_eq!(e.shown, ratings.player(BLITZ, alice()).shown);
    let e = events.pop_front().unwrap();
    assert_eq!((e.player, e.opponent, e.score, e.band), (bob(), alice(), 0, 2));
}

#[test]
fn a_retiring_channel_rates_but_takes_no_tickets() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    set_contract_address(owner());
    ratings.set_channel(channel(), CHANNEL_RETIRING);
    set_contract_address(channel());
    assert!(ratings.rate_game(ticket, game).is_some());
    assert_eq!(ratings.channel_state(channel()), CHANNEL_RETIRING);
    // Removed, it rates nothing more.
    let (ticket2, game2) = (ticket_for(2, T0, alice(), bob(), QUEUE), result(2, T0, 1));
    set_contract_address(owner());
    ratings.set_channel(channel(), NONE);
    set_contract_address(channel());
    assert!(ratings.rate_game(ticket2, game2).is_none());
}

#[test]
fn the_rank_offset_shifts_every_rank_shown() {
    let ratings = setup();
    let (ticket, game) = play(ratings, 1, 1);
    let (a, _) = ratings.rate_game(ticket, game).unwrap();
    set_contract_address(owner());
    ratings.set_rank_offset(BLITZ, -12);
    assert_eq!(ratings.rank_offset(BLITZ), -12);
    assert_eq!(ratings.player(BLITZ, alice()).shown, a.shown - 12);
    assert_eq!(rating(ratings, alice()).mu, a.mu.into());
}

// ---- Administration ----

#[test]
#[should_panic(expected: ('Only owner', 'ENTRYPOINT_FAILED'))]
fn only_the_owner_administers() {
    let ratings = setup();
    ratings.set_channel(channel(), NONE);
}

#[test]
fn after_sealing_loosening_waits_for_the_timelock() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    assert!(ratings.sealed());
    let key = public_key(0x5eed);
    let op = admin_op::<TestRules>('set_matchmaker', array![key].span());
    ratings.queue(op);
    assert_eq!(ratings.queued(op), T0);
    set_block_timestamp(T0 + TIMELOCK_SECONDS);
    ratings.set_matchmaker(key);
    assert_eq!(ratings.matchmaker(key), (1, 0));
    // Consumed: a second use needs a new queue.
    assert_eq!(ratings.queued(op), 0);
}

#[test]
#[should_panic(expected: ('Timelocked', 'ENTRYPOINT_FAILED'))]
fn a_queued_change_waits() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    ratings.queue(admin_op::<TestRules>('set_prover', array!['new prover'].span()));
    set_block_timestamp(T0 + TIMELOCK_SECONDS - 1);
    ratings.set_prover('new prover'.try_into().unwrap(), true);
}

#[test]
#[should_panic(expected: ('Queued change expired', 'ENTRYPOINT_FAILED'))]
fn a_queued_change_expires() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    ratings.queue(admin_op::<TestRules>('set_prover', array!['new prover'].span()));
    set_block_timestamp(T0 + QUEUE_LIFE + 1);
    ratings.set_prover('new prover'.try_into().unwrap(), true);
}

#[test]
#[should_panic(expected: ('Not queued', 'ENTRYPOINT_FAILED'))]
fn a_cancelled_change_never_applies() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    let op = admin_op::<TestRules>('set_rank_offset', array![BLITZ, 0x80000000 + 5].span());
    ratings.queue(op);
    ratings.cancel(op);
    set_block_timestamp(T0 + TIMELOCK_SECONDS);
    ratings.set_rank_offset(BLITZ, 5);
}

#[test]
#[should_panic(expected: ('Not queued', 'ENTRYPOINT_FAILED'))]
fn upgrades_are_timelocked() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    ratings.upgrade(TestRatings::TEST_CLASS_HASH);
}

#[test]
fn tightening_applies_at_once_after_sealing() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.seal();
    ratings.retire_matchmaker(public_key(PK_MATCHMAKER));
    ratings.revoke_referee(public_key(PK_REFEREE), T0);
    ratings.set_prover(prover(), false);
    ratings.set_clock_preset(BLITZ, settings(), false);
    ratings.set_config(BLITZ, CONFIG, false);
    ratings.set_start_bands(BLITZ, 0b10);
    ratings.set_response_window(400, 800);
    ratings.set_channel(channel(), CHANNEL_RETIRING);
    assert_eq!(ratings.channel_state(channel()), CHANNEL_RETIRING);
    assert_eq!(ratings.start_bands(BLITZ), 0b10);
    assert!(!ratings.is_config(BLITZ, CONFIG) && !ratings.is_clock_preset(BLITZ, settings()));
}

#[test]
#[should_panic(expected: ('Key revoked', 'ENTRYPOINT_FAILED'))]
fn a_revoked_key_stays_revoked() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.revoke_matchmaker(public_key(PK_MATCHMAKER), T0);
    ratings.set_matchmaker(public_key(PK_MATCHMAKER));
}

#[test]
fn ownership_transfers_in_two_steps() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.transfer_ownership(channel());
    assert_eq!((ratings.owner(), ratings.pending_owner()), (owner(), channel()));
    set_contract_address(channel());
    ratings.accept_ownership();
    assert_eq!(ratings.owner(), channel());
    ratings.retire_referee(public_key(PK_REFEREE));
    assert_eq!(ratings.referee(public_key(PK_REFEREE)), (2, 0));
}

#[test]
#[should_panic(expected: ('Not pending owner', 'ENTRYPOINT_FAILED'))]
fn only_the_pending_owner_accepts() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.transfer_ownership(channel());
    set_contract_address('stranger'.try_into().unwrap());
    ratings.accept_ownership();
}

#[test]
fn many_games_pack_and_unpack_exactly() {
    // Nine games, before either side can be settled, both following the math
    // through every pack and unpack.
    let ratings = setup();
    let p = test_pool();
    let mut a = start(3);
    let mut b = start(2);
    for i in 1..10_u32 {
        let id: felt252 = i.into();
        let winner = if i % 3 == 0 {
            0
        } else if i % 2 == 0 {
            2
        } else {
            1
        };
        let (ticket, game) = play(ratings, id, winner);
        ratings.rate_game(ticket, game).unwrap();
        let (na, nb) = math::update_states::<
            TestRules,
        >(BLITZ, @p, a, b, match winner {
            0 => 1,
            1 => 2,
            _ => 0,
        }, game.played_at);
        a = na;
        b = nb;
        assert_eq!(rating(ratings, alice()), a);
        assert_eq!(rating(ratings, bob()), b);
    }
    let player = ratings.player(BLITZ, alice());
    assert_eq!((player.games, player.wins, player.losses, player.draws), (9, 3, 3, 3));
    assert!(player.phi.into() < ONE * 2);
}

/// A mixed blitz season whose raw events an SDK replay check can replay:
/// settled players, a newcomer, a short onchain forfeit, a void, a draw, a
/// long idle spell and an anchor on either side.
#[test]
fn events_for_replay() {
    let ratings = setup();
    let next = settle_both(ratings, alice(), bob(), 14);
    let newcomer: ContractAddress = 'newcomer'.try_into().unwrap();
    let ai: ContractAddress = 'ai'.try_into().unwrap();
    set_contract_address(owner());
    // Pinned at 1800.
    ratings.set_anchor(BLITZ, ai, 7417145753);
    let mut t = T0 + 20 * 3600;
    let mut id = next;
    for (a, b, winner, steps, forfeit) in array![
        (alice(), newcomer, 1_u8, 60_u32, false), (newcomer, bob(), 2, 3, true),
        (bob(), alice(), 0, 80, false), (alice(), bob(), 1, 2, false),
        (newcomer, alice(), 1, 40, false), (ai, alice(), 2, 60, false),
        (newcomer, ai, 2, 50, false),
    ] {
        let mut ticket = ticket_for(id, t, a, b, QUEUE);
        if a == ai {
            ticket.band_0 = 0;
        }
        if b == ai {
            ticket.band_1 = 0;
        }
        let ticket = accept(ratings, ticket, id);
        let _ = ratings
            .rate_game(
                ticket,
                GameResult {
                    reason: if forfeit {
                        REASON_RESIGN
                    } else {
                        1
                    },
                    steps,
                    onchain_forfeit: forfeit,
                    ..result(id, t, winner),
                },
            );
        id += 1;
        t += 400 * 86400;
    }
    loop {
        match pop_log_raw(ratings.contract_address) {
            Option::Some((
                keys, data,
            )) => {
                print!("EVENT");
                for k in keys {
                    print!(" {}", *k);
                }
                print!(" |");
                for d in data {
                    print!(" {}", *d);
                }
                println!("");
            },
            Option::None => { break; },
        }
    }
}
