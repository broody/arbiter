use arbiter::Signature;
use arbiter::clocks::{Standard, encode};
use arbiter_testing::{public_key, sign};
use core::poseidon::poseidon_hash_span;
use starknet::syscalls::deploy_syscall;
use starknet::testing::{set_block_timestamp, set_contract_address};
use starknet::{ContractAddress, SyscallResultTrait, get_tx_info};
use crate::ratings::{
    ACCEPTED, CHANNEL_ACTIVE, CHANNEL_RETIRING, IRatingsDispatcher, IRatingsDispatcherTrait,
    MAX_TICKET_LIFE, NONE, QUEUE,
};
use crate::tests::contract::TestRatings;
use crate::tests::rules::{BLITZ, RAPID, TestRules};
use crate::ticket::{Ticket, digest};

const PK_MATCHMAKER: felt252 = 0x3a7c4;
const PK_REFEREE: felt252 = 0x7e7e7e;
const NOW: u64 = 1_700_000_000;
const GAME: felt252 = 42;
/// Two rated configs' hashes (`arbiter::config_hash`).
const CONFIG: felt252 = 'rated config';
const SHORT_CONFIG: felt252 = 'short config';

fn owner() -> ContractAddress {
    'owner'.try_into().unwrap()
}

fn channel() -> ContractAddress {
    'channel'.try_into().unwrap()
}

fn prover() -> ContractAddress {
    'prover'.try_into().unwrap()
}

fn alice() -> ContractAddress {
    'alice'.try_into().unwrap()
}

fn bob() -> ContractAddress {
    'bob'.try_into().unwrap()
}

/// Three minutes a side, two seconds a move.
fn settings() -> Span<felt252> {
    encode(@Standard { turn_ms: 0, bank_ms: 180000, increment_ms: 2000, byoyomi: Option::None })
}

fn deploy(salt: felt252) -> IRatingsDispatcher {
    let (address, _) = deploy_syscall(
        TestRatings::TEST_CLASS_HASH, salt, array![owner().into()].span(), false,
    )
        .unwrap_syscall();
    IRatingsDispatcher { contract_address: address }
}

/// A contract whose policy accepts `ticket()`, called as `channel()` at `NOW`.
fn setup() -> IRatingsDispatcher {
    let ratings = deploy(0);
    set_contract_address(owner());
    ratings.set_channel(channel(), CHANNEL_ACTIVE);
    ratings.set_matchmaker(public_key(PK_MATCHMAKER));
    ratings.set_referee(public_key(PK_REFEREE));
    // Every band: the policy on new players' bands has its own tests.
    ratings.set_start_bands(BLITZ, 0b10111110);
    ratings.set_clock_preset(BLITZ, settings(), true);
    ratings.set_prover(prover(), true);
    ratings.set_config(BLITZ, CONFIG, true);
    ratings.set_config(BLITZ, SHORT_CONFIG, true);
    ratings.set_response_window(300, 900);
    set_contract_address(channel());
    set_block_timestamp(NOW);
    ratings
}

fn ticket() -> Ticket {
    Ticket {
        chain_id: get_tx_info().unbox().chain_id,
        channel: channel(),
        player_0: alice(),
        player_1: bob(),
        pool: BLITZ,
        config: CONFIG,
        referee: public_key(PK_REFEREE),
        clock: poseidon_hash_span(settings()),
        prover: prover(),
        response_seconds: 600,
        source: QUEUE,
        band_0: 3,
        band_1: 2,
        matchmaker: public_key(PK_MATCHMAKER),
        issued_at: NOW - 30,
        expires_at: NOW + 270,
        nonce: 7,
    }
}

fn digest_at(ratings: IRatingsDispatcher, ticket: @Ticket) -> felt252 {
    digest::<TestRules>(ticket, ratings.contract_address)
}

fn signed(ratings: IRatingsDispatcher, ticket: Ticket) -> Signature {
    sign(digest_at(ratings, @ticket), PK_MATCHMAKER)
}

/// Sign `ticket` as the matchmaker and check it as `channel()`.
fn check(ratings: IRatingsDispatcher, ticket: Ticket) -> felt252 {
    ratings.check_ticket(ticket, signed(ratings, ticket), GAME)
}

#[test]
fn accepts_a_ticket_once() {
    let ratings = setup();
    let t = ticket();
    assert_eq!(ratings.ticket_status(digest_at(ratings, @t)), (NONE, 0));
    assert_eq!(check(ratings, t), digest_at(ratings, @t));
    assert_eq!(ratings.ticket_status(digest_at(ratings, @t)), (ACCEPTED, GAME));
    let mut other = t;
    other.nonce = 8;
    check(ratings, other);
}

#[test]
#[should_panic(expected: ('Ticket used', 'ENTRYPOINT_FAILED'))]
fn rejects_a_replay() {
    let ratings = setup();
    check(ratings, ticket());
    check(ratings, ticket());
}

/// The other valid signature of the same message, (r, n − s), is the same
/// ticket: used tickets are keyed on the digest.
#[test]
#[should_panic(expected: ('Ticket used', 'ENTRYPOINT_FAILED'))]
fn rejects_a_replay_with_the_mirrored_signature() {
    let ratings = setup();
    let t = ticket();
    let signature = signed(ratings, t);
    ratings.check_ticket(t, signature, GAME);
    let order: felt252 = core::ec::stark_curve::ORDER;
    ratings.check_ticket(t, Signature { r: signature.r, s: order - signature.s }, GAME);
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn rejects_a_changed_ticket() {
    let ratings = setup();
    let t = ticket();
    let signature = signed(ratings, t);
    let mut changed = t;
    changed.band_1 = 4;
    ratings.check_ticket(changed, signature, GAME);
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn rejects_another_signer() {
    let ratings = setup();
    let t = ticket();
    ratings.check_ticket(t, sign(digest_at(ratings, @t), 0x999), GAME);
}

#[test]
#[should_panic(expected: ('Matchmaker not allowed', 'ENTRYPOINT_FAILED'))]
fn rejects_an_unknown_matchmaker() {
    let ratings = setup();
    let mut t = ticket();
    t.matchmaker = public_key(0x999);
    ratings.check_ticket(t, sign(digest_at(ratings, @t), 0x999), GAME);
}

#[test]
#[should_panic(expected: ('Unknown channel', 'ENTRYPOINT_FAILED'))]
fn rejects_an_unknown_channel() {
    let ratings = setup();
    set_contract_address('stranger'.try_into().unwrap());
    check(ratings, ticket());
}

#[test]
#[should_panic(expected: ('Wrong channel', 'ENTRYPOINT_FAILED'))]
fn rejects_another_channels_ticket() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_channel('other'.try_into().unwrap(), CHANNEL_ACTIVE);
    set_contract_address('other'.try_into().unwrap());
    check(ratings, ticket());
}

#[test]
#[should_panic(expected: ('Wrong chain', 'ENTRYPOINT_FAILED'))]
fn rejects_another_chain() {
    let ratings = setup();
    let mut t = ticket();
    t.chain_id += 1;
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Invalid players', 'ENTRYPOINT_FAILED'))]
fn rejects_an_open_seat() {
    let ratings = setup();
    let mut t = ticket();
    t.player_1 = 0.try_into().unwrap();
    check(ratings, t);
}

#[test]
fn accepts_a_ticket_after_it_expired() {
    // A game opens when it first needs the chain, often at its settlement:
    // rating checks that it started in the ticket's window instead.
    let ratings = setup();
    let t = ticket();
    set_block_timestamp(t.expires_at + 3600);
    assert_eq!(check(ratings, t), digest_at(ratings, @t));
}

#[test]
#[should_panic(expected: ('Ticket expires before issue', 'ENTRYPOINT_FAILED'))]
fn rejects_a_ticket_that_expires_before_it_is_issued() {
    let ratings = setup();
    let mut t = ticket();
    t.expires_at = t.issued_at - 1;
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Ticket lives too long', 'ENTRYPOINT_FAILED'))]
fn rejects_a_long_lived_ticket() {
    let ratings = setup();
    let mut t = ticket();
    t.expires_at = t.issued_at + MAX_TICKET_LIFE + 1;
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Invalid source', 'ENTRYPOINT_FAILED'))]
fn rejects_an_unknown_source() {
    let ratings = setup();
    let mut t = ticket();
    t.source = 3;
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Invalid band', 'ENTRYPOINT_FAILED'))]
fn rejects_an_invalid_band() {
    let ratings = setup();
    let mut t = ticket();
    t.band_0 = 0;
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Config not allowed', 'ENTRYPOINT_FAILED'))]
fn rejects_a_config_no_longer_allowed() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_config(BLITZ, SHORT_CONFIG, false);
    set_contract_address(channel());
    let mut t = ticket();
    t.config = SHORT_CONFIG;
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Config not allowed', 'ENTRYPOINT_FAILED'))]
fn rejects_an_unknown_config() {
    let ratings = setup();
    let mut t = ticket();
    t.config = 'unrated config';
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Referee not allowed', 'ENTRYPOINT_FAILED'))]
fn rejects_an_unknown_referee() {
    let ratings = setup();
    let mut t = ticket();
    t.referee = public_key(0x999);
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Clock not allowed', 'ENTRYPOINT_FAILED'))]
fn rejects_another_clock() {
    let ratings = setup();
    let mut t = ticket();
    t
        .clock =
            poseidon_hash_span(
                encode(
                    @Standard {
                        turn_ms: 0, bank_ms: 60000, increment_ms: 0, byoyomi: Option::None,
                    },
                ),
            );
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Prover not allowed', 'ENTRYPOINT_FAILED'))]
fn rejects_an_unknown_prover() {
    let ratings = setup();
    let mut t = ticket();
    t.prover = 'rogue'.try_into().unwrap();
    check(ratings, t);
}

#[test]
#[should_panic(expected: ('Response window not allowed', 'ENTRYPOINT_FAILED'))]
fn rejects_a_long_response_window() {
    let ratings = setup();
    let mut t = ticket();
    t.response_seconds = 604800;
    check(ratings, t);
}

#[test]
fn policy_views() {
    let ratings = setup();
    assert!(ratings.is_clock_preset(BLITZ, settings()));
    assert!(!ratings.is_clock_preset(RAPID, settings()));
    assert!(ratings.is_prover(prover()));
    assert!(ratings.is_config(BLITZ, CONFIG) && ratings.is_config(BLITZ, SHORT_CONFIG));
    assert!(!ratings.is_config(RAPID, CONFIG));
    assert_eq!(ratings.response_window(), (300, 900));
    assert_eq!(ratings.start_bands(BLITZ), 0b10111110);
    set_contract_address(owner());
    ratings.set_config(BLITZ, SHORT_CONFIG, false);
    assert!(!ratings.is_config(BLITZ, SHORT_CONFIG));
    assert!(ratings.is_config(BLITZ, CONFIG));
}

#[test]
#[should_panic(expected: ('Only owner', 'ENTRYPOINT_FAILED'))]
fn only_the_owner_sets_policy() {
    let ratings = setup();
    ratings.set_prover(prover(), false);
}

#[test]
#[should_panic(expected: ('Band not allowed', 'ENTRYPOINT_FAILED'))]
fn a_new_player_chooses_only_the_allowed_bands() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_start_bands(BLITZ, 0b110);
    set_contract_address(channel());
    // Band 3 (1500) for a player with no rated games.
    check(ratings, ticket());
}

#[test]
#[should_panic(expected: ('Band not allowed', 'ENTRYPOINT_FAILED'))]
fn no_band_is_allowed_until_set() {
    let ratings = deploy(1);
    assert_eq!((ratings.start_bands(BLITZ), ratings.start_bands(RAPID)), (0, 0));
    set_contract_address(owner());
    ratings.set_channel(channel(), CHANNEL_ACTIVE);
    set_contract_address(channel());
    set_block_timestamp(NOW);
    check(ratings, ticket());
}

#[test]
#[should_panic(expected: ('Unknown channel', 'ENTRYPOINT_FAILED'))]
fn a_retiring_channel_takes_no_tickets() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.set_channel(channel(), CHANNEL_RETIRING);
    set_contract_address(channel());
    check(ratings, ticket());
}

#[test]
#[should_panic(expected: ('Referee not allowed', 'ENTRYPOINT_FAILED'))]
fn a_retired_referee_names_no_new_tickets() {
    let ratings = setup();
    set_contract_address(owner());
    ratings.retire_referee(public_key(PK_REFEREE));
    set_contract_address(channel());
    check(ratings, ticket());
}

#[test]
fn a_ticket_keeps_a_full_felt_game_id() {
    // Game ids are the seats' hash, so any felt.
    let ratings = setup();
    let t = ticket();
    let game_id = 0x7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    let digest = ratings.check_ticket(t, signed(ratings, t), game_id);
    assert_eq!(ratings.ticket_status(digest), (ACCEPTED, game_id));
}
