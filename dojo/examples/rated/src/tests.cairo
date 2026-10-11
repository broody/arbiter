use arbiter::clocks::{Standard, encode};
use arbiter::{
    Batch, Envelope, Move, REFEREE, Signature, Terms, TimeControl, action_hash, actor, apply_steps,
    checkpoint_hash, config_hash, context_hash, game_id_of, open, stamp_hash, state_hash,
    terms_message, tip_hash,
};
use arbiter_counter::{ADD, Action, Counter};
use arbiter_dojo::models::{
    RatedGame, Settlement, VIA_RESIGN, VIA_TRANSCRIPT, e_ChannelUpdated, m_ChannelRng,
    m_ChannelState, m_ChannelTerms, m_ProverAllowed, m_RatedGame, m_Settlement,
};
use arbiter_ratings::math::{self, update_states};
use arbiter_ratings::ratings::{ACCEPTED, CHANNEL_ACTIVE, QUEUE, RATED};
use arbiter_ratings::{IRatingsDispatcher, IRatingsDispatcherTrait, Ticket, digest};
use arbiter_testing::{chain_value, public_key, sign};
use core::hash::HashStateTrait;
use core::pedersen::PedersenTrait;
use core::poseidon::poseidon_hash_span;
use dojo::model::ModelStorage;
use dojo::world::{WorldStorage, WorldStorageTrait, world};
use dojo_cairo_test::{
    ContractDef, ContractDefTrait, NamespaceDef, TestResource, WorldStorageTestTrait,
    spawn_test_world,
};
use starknet::syscalls::{deploy_syscall, get_class_hash_at_syscall};
use starknet::testing::{set_account_contract_address, set_block_timestamp, set_contract_address};
use starknet::{ContractAddress, SyscallResultTrait, get_tx_info};
use crate::account::TestAccount;
use crate::rolled::{IRolledChannelDispatcher, IRolledChannelDispatcherTrait, rolled_channel};
use crate::{
    BLITZ, Config, CounterRatingRules, CounterRatings, IRatedChannelDispatcher,
    IRatedChannelDispatcherTrait, RAPID, RatedCounterRules, channel,
};

const PK_A: felt252 = 0x1a2b3c;
const PK_B: felt252 = 0x4d5e6f;
/// Session keys for a second game between the same wallets.
const PK_C: felt252 = 0x1c2c3c;
const PK_D: felt252 = 0x4f5f6f;
const PK_REF: felt252 = 0x7e7e7e;
const PK_MM: felt252 = 0x3a7c4;
const SEED_A: felt252 = 0x5eed0;
const SEED_B: felt252 = 0x5eed1;
const RNG_LEN: u32 = 16;
const WINDOW: u32 = 3600;
const TARGET: u8 = 20;
/// A config the policy allows only in blitz.
const BLITZ_ONLY: u8 = 30;
const WALLET_A: felt252 = 0xa11ce5;
const WALLET_B: felt252 = 0xb0b5;
/// When the matchmaker paired the players; the referee's stamps start a
/// second later.
const ISSUED: u64 = 1000;
const SETTLED_AT: u64 = 1100;

fn wallet(salt: felt252, key: felt252) -> ContractAddress {
    let class_hash: felt252 = TestAccount::TEST_CLASS_HASH.into();
    let calldata = PedersenTrait::new(0).update(public_key(key)).update(1).finalize();
    let hash = PedersenTrait::new(0)
        .update('STARKNET_CONTRACT_ADDRESS')
        .update(0)
        .update(salt)
        .update(class_hash)
        .update(calldata)
        .update(5)
        .finalize();
    let hash: u256 = hash.into();
    let bound: u256 = 0x800000000000000000000000000000000000000000000000000000000000000 - 256;
    let address: felt252 = (hash % bound).try_into().unwrap();
    address.try_into().unwrap()
}

fn ALICE() -> ContractAddress {
    wallet('ALICE', WALLET_A)
}

fn BOB() -> ContractAddress {
    wallet('BOB', WALLET_B)
}

fn CAROL() -> ContractAddress {
    'CAROL'.try_into().unwrap()
}

fn OWNER() -> ContractAddress {
    'OWNER'.try_into().unwrap()
}

fn deploy_wallet(salt: felt252, key: felt252) {
    let address = wallet(salt, key);
    if get_class_hash_at_syscall(address).unwrap_or(0.try_into().unwrap()).into() != 0 {
        return;
    }
    let (deployed, _) = deploy_syscall(
        TestAccount::TEST_CLASS_HASH, salt, array![public_key(key)].span(), true,
    )
        .unwrap_syscall();
    assert_eq!(deployed, address);
}

fn caller(address: ContractAddress) {
    set_contract_address(address);
    set_account_contract_address(address);
}

fn settings() -> Span<felt252> {
    encode(@Standard { turn_ms: 30000, bank_ms: 60000, increment_ms: 2000, byoyomi: Option::None })
}

fn blitz_clock() -> Option<TimeControl> {
    Option::Some(TimeControl { referee: public_key(PK_REF), settings: settings(), rng_tip: 0 })
}

fn config_of(target: u8) -> felt252 {
    config_hash::<RatedCounterRules>(@Config { target, ticket: 0 })
}

/// A world with the rated channel and a ratings contract that accepts its
/// rated games in both pools.
fn setup() -> (IRatedChannelDispatcher, IRatingsDispatcher, WorldStorage) {
    let ndef = NamespaceDef {
        namespace: "rated",
        resources: [
            TestResource::Model(m_ChannelTerms::TEST_CLASS_HASH),
            TestResource::Model(m_ChannelState::TEST_CLASS_HASH),
            TestResource::Model(m_ChannelRng::TEST_CLASS_HASH),
            TestResource::Model(m_ProverAllowed::TEST_CLASS_HASH),
            TestResource::Model(m_Settlement::TEST_CLASS_HASH),
            TestResource::Model(m_RatedGame::TEST_CLASS_HASH),
            TestResource::Event(e_ChannelUpdated::TEST_CLASS_HASH),
            TestResource::Contract(channel::TEST_CLASS_HASH),
            TestResource::Contract(rolled_channel::TEST_CLASS_HASH),
        ]
            .span(),
    };
    let defs: Span<ContractDef> = [
        ContractDefTrait::new(@"rated", @"channel")
            .with_writer_of([dojo::utils::bytearray_hash(@"rated")].span()),
        ContractDefTrait::new(@"rated", @"rolled_channel")
            .with_writer_of([dojo::utils::bytearray_hash(@"rated")].span()),
    ]
        .span();
    let mut world = spawn_test_world(world::TEST_CLASS_HASH, [ndef].span());
    world.sync_perms_and_inits(defs);
    deploy_wallet('ALICE', WALLET_A);
    deploy_wallet('BOB', WALLET_B);
    let (contract_address, _) = world.dns(@"channel").unwrap();
    let game = IRatedChannelDispatcher { contract_address };
    let (address, _) = deploy_syscall(
        CounterRatings::TEST_CLASS_HASH, 0, array![OWNER().into()].span(), false,
    )
        .unwrap_syscall();
    let ratings = IRatingsDispatcher { contract_address: address };
    game.set_ratings(address);
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
    caller(OWNER());
    ratings.set_channel(contract_address, CHANNEL_ACTIVE);
    ratings.set_matchmaker(public_key(PK_MM));
    ratings.set_referee(public_key(PK_REF));
    ratings.set_prover(contract_address, true);
    ratings.set_response_window(60, 7200);
    for pool in array![BLITZ, RAPID] {
        ratings.set_clock_preset(pool, settings(), true);
        ratings.set_config(pool, config_of(TARGET), true);
        ratings.set_start_bands(pool, 0b1110);
    }
    ratings.set_config(BLITZ, config_of(BLITZ_ONLY), true);
    caller(CAROL());
    (game, ratings, world)
}

fn keys() -> Span<felt252> {
    array![public_key(PK_A), public_key(PK_B)].span()
}

fn other_keys() -> Span<felt252> {
    array![public_key(PK_C), public_key(PK_D)].span()
}

/// A blitz ticket for Alice (seat 0) and Bob (seat 1) on `game`'s channel.
fn ticket_for(game: IRatedChannelDispatcher, pool: felt252) -> Ticket {
    Ticket {
        chain_id: get_tx_info().chain_id,
        channel: game.contract_address,
        player_0: ALICE(),
        player_1: BOB(),
        pool,
        config: config_of(TARGET),
        referee: public_key(PK_REF),
        clock: poseidon_hash_span(settings()),
        prover: game.contract_address,
        response_seconds: WINDOW,
        source: QUEUE,
        band_0: 2,
        band_1: 2,
        matchmaker: public_key(PK_MM),
        issued_at: ISSUED,
        expires_at: ISSUED + 300,
        nonce: 1,
    }
}

/// Alice's and Bob's terms for a game rated under the ticket with `digest`.
fn terms_for(
    game: IRatedChannelDispatcher, keys: Span<felt252>, target: u8, ticket: felt252,
) -> Terms<Config> {
    let players = array![ALICE().into(), BOB().into()].span();
    Terms {
        chain_id: get_tx_info().chain_id,
        channel: game.contract_address.into(),
        game_id: game_id_of(players, keys),
        prover: game.contract_address.into(),
        response_seconds: WINDOW,
        clock: blitz_clock(),
        players,
        keys,
        rng_tips: array![chain_value(SEED_A, RNG_LEN), chain_value(SEED_B, RNG_LEN)].span(),
        config: Config { target, ticket },
    }
}

fn wallet_signature(terms: @Terms<Config>, seat: u32, key: felt252) -> Span<felt252> {
    let context = context_hash::<RatedCounterRules>(terms);
    let message = terms_message::<
        RatedCounterRules,
    >(*terms.chain_id, *terms.game_id, context, *terms.players.at(seat));
    let signature = sign(message, key);
    array![signature.r, signature.s].span()
}

fn signed_by_both(terms: @Terms<Config>) -> Span<Span<felt252>> {
    array![wallet_signature(terms, 0, WALLET_A), wallet_signature(terms, 1, WALLET_B)].span()
}

fn ticket_digest(ratings: IRatingsDispatcher, ticket: @Ticket) -> felt252 {
    digest::<CounterRatingRules>(ticket, ratings.contract_address)
}

/// Open `terms` as rated under `ticket`, signed by the matchmaker.
fn open_with(
    game: IRatedChannelDispatcher,
    ratings: IRatingsDispatcher,
    terms: Terms<Config>,
    ticket: Ticket,
) {
    let signatures = signed_by_both(@terms);
    caller(CAROL());
    game.open_rated_game(terms, signatures, ticket, sign(ticket_digest(ratings, @ticket), PK_MM));
}

/// Open Alice's and Bob's game rated under `ticket`; returns its terms.
fn open_rated(
    game: IRatedChannelDispatcher, ratings: IRatingsDispatcher, ticket: Ticket, keys: Span<felt252>,
) -> Terms<Config> {
    let terms = terms_for(game, keys, TARGET, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
    terms
}

fn add(amount: u8) -> Move<Action> {
    Move::Play(Action { kind: ADD, amount })
}

/// Alice reaches 20 first: 3, 3, 3, 3, 3, 3, then 2.
fn full_game() -> Span<Move<Action>> {
    array![add(3), add(3), add(3), add(3), add(3), add(3), add(2)].span()
}

/// Stamps from a second after the ticket was issued, in milliseconds.
fn stamps() -> Span<u64> {
    array![1001000, 1011000, 1021000, 1031000, 1041000, 1051000, 1061000].span()
}

/// Each step signed by its seat and stamped by the referee.
fn stamp_steps(
    terms: @Terms<Config>, start: Envelope<Counter>, steps: Span<Move<Action>>, stamps: Span<u64>,
) -> (Batch<Action>, Envelope<Counter>) {
    let context = context_hash::<RatedCounterRules>(terms);
    let mut env = start;
    let mut finals = array![Signature { r: 0, s: 0 }, Signature { r: 0, s: 0 }].span();
    let mut i = 0;
    for step in steps {
        let seat = actor::<RatedCounterRules>(@env, step);
        let message = action_hash::<RatedCounterRules>(context, env.seq, env.transcript, step);
        finals =
            if seat == REFEREE {
                finals
            } else if seat == 0 {
                array![sign(message, PK_A), *finals.at(1)].span()
            } else {
                array![*finals.at(0), sign(message, PK_B)].span()
            };
        env =
            apply_steps::<
                RatedCounterRules,
            >(context, terms, env, (), array![*step].span(), stamps.slice(i, 1));
        i += 1;
    }
    let clock = env.clock.unwrap();
    let attestation = sign(
        stamp_hash::<RatedCounterRules>(context, env.seq, env.transcript, @clock), PK_REF,
    );
    (Batch { steps, stamps, signatures: finals, attestation }, env)
}

/// Play `terms`' game to Alice's win and settle it by its transcript.
fn play_out(game: IRatedChannelDispatcher, terms: @Terms<Config>) {
    let start = open::<RatedCounterRules>(terms);
    let (batch, end) = stamp_steps(terms, start, full_game(), stamps());
    let context = context_hash::<RatedCounterRules>(terms);
    let message = checkpoint_hash::<
        RatedCounterRules,
    >(context, 0, state_hash::<RatedCounterRules>(@end));
    let acks = array![sign(message, PK_A), sign(message, PK_B)].span();
    set_block_timestamp(SETTLED_AT);
    caller(CAROL());
    game.submit_history(*terms.game_id, 0, start, batch, acks);
}

#[test]
fn a_rated_game_opens_on_its_ticket() {
    let (game, ratings, world) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = open_rated(game, ratings, ticket, keys());
    let digest = ticket_digest(ratings, @ticket);
    let rated: RatedGame = world.read_model(terms.game_id);
    assert_eq!(rated.ticket, digest);
    assert_eq!(ratings.ticket_status(digest), (ACCEPTED, terms.game_id));
    assert_eq!(game.get_channel(terms.game_id).player_0, ALICE());
}

#[test]
#[should_panic(expected: ('Rated game needs its ticket', 'ENTRYPOINT_FAILED'))]
fn a_rated_config_opens_only_as_rated() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket));
    game.open_game(terms, signed_by_both(@terms));
}

#[test]
fn an_unrated_game_opens_without_a_ticket() {
    let (game, _, world) = setup();
    let terms = terms_for(game, keys(), TARGET, 0);
    game.open_game(terms, signed_by_both(@terms));
    let rated: RatedGame = world.read_model(terms.game_id);
    assert_eq!(rated.ticket, 0);
}

#[test]
#[should_panic(expected: ('Not the ticket game', 'ENTRYPOINT_FAILED'))]
fn the_config_must_carry_the_tickets_digest() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, Ticket { nonce: 2, ..ticket });
}

#[test]
#[should_panic(expected: ('Not the ticket config', 'ENTRYPOINT_FAILED'))]
fn the_config_must_be_the_tickets() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = terms_for(game, keys(), 21, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Not the ticket players', 'ENTRYPOINT_FAILED'))]
fn the_seats_must_be_the_tickets() {
    let (game, ratings, _) = setup();
    let ticket = Ticket { player_0: BOB(), player_1: ALICE(), ..ticket_for(game, BLITZ) };
    let terms = terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Not the ticket referee', 'ENTRYPOINT_FAILED'))]
fn the_referee_must_be_the_tickets() {
    let (game, ratings, _) = setup();
    let ticket = Ticket { referee: public_key(PK_MM), ..ticket_for(game, BLITZ) };
    let terms = terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Not the ticket clock', 'ENTRYPOINT_FAILED'))]
fn the_clock_must_be_the_tickets() {
    let (game, ratings, _) = setup();
    let ticket = Ticket { clock: 'another clock', ..ticket_for(game, BLITZ) };
    let terms = terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Rated game is untimed', 'ENTRYPOINT_FAILED'))]
fn a_rated_game_is_timed() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = Terms {
        clock: Option::None, ..terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket)),
    };
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Rated game takes no rolls', 'ENTRYPOINT_FAILED'))]
fn a_rated_game_without_referee_rolls_has_no_tip() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    let rolled = Option::Some(
        TimeControl { rng_tip: chain_value('rolls', RNG_LEN), ..blitz_clock().unwrap() },
    );
    let terms = Terms {
        clock: rolled, ..terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket)),
    };
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Not the ticket prover', 'ENTRYPOINT_FAILED'))]
fn the_prover_must_be_the_tickets() {
    let (game, ratings, _) = setup();
    let ticket = Ticket { prover: CAROL(), ..ticket_for(game, BLITZ) };
    let terms = terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Not the ticket window', 'ENTRYPOINT_FAILED'))]
fn the_response_window_must_be_the_tickets() {
    let (game, ratings, _) = setup();
    let ticket = Ticket { response_seconds: 600, ..ticket_for(game, BLITZ) };
    let terms = terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
}

#[test]
#[should_panic(expected: ('Ticket used', 'ENTRYPOINT_FAILED', 'ENTRYPOINT_FAILED'))]
fn a_ticket_opens_one_game() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    open_rated(game, ratings, ticket, keys());
    open_rated(game, ratings, ticket, other_keys());
}

#[test]
#[should_panic(expected: ('Config not allowed', 'ENTRYPOINT_FAILED', 'ENTRYPOINT_FAILED'))]
fn a_config_is_allowed_per_pool() {
    let (game, ratings, _) = setup();
    let ticket = Ticket { config: config_of(BLITZ_ONLY), ..ticket_for(game, RAPID) };
    let terms = terms_for(game, keys(), BLITZ_ONLY, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
}

#[test]
fn a_config_allowed_in_its_pool_opens() {
    let (game, ratings, _) = setup();
    let ticket = Ticket { config: config_of(BLITZ_ONLY), ..ticket_for(game, BLITZ) };
    let terms = terms_for(game, keys(), BLITZ_ONLY, ticket_digest(ratings, @ticket));
    open_with(game, ratings, terms, ticket);
    assert_eq!(game.get_channel(terms.game_id).player_1, BOB());
}

#[test]
fn a_settled_rated_game_rates_both_seats_from_its_first_stamp() {
    let (game, ratings, world) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = open_rated(game, ratings, ticket, keys());
    play_out(game, @terms);
    let settlement: Settlement = world.read_model(terms.game_id);
    assert_eq!((settlement.timestamp, settlement.via), (SETTLED_AT, VIA_TRANSCRIPT));
    let (result, alice, bob) = game.rate(terms.game_id, ticket).unwrap();
    assert_eq!((result.played_at, result.steps, result.onchain_forfeit), (1001, 7, false));
    // The game is dated by the referee's first stamp, 1001 s.
    let pool = ratings.pool(BLITZ).unwrap();
    let start = math::start::<CounterRatingRules>(BLITZ, 2).unwrap();
    let (a, b) = update_states::<CounterRatingRules>(BLITZ, @pool, start, start, 2, 1001);
    assert_eq!((alice.mu.into(), alice.phi.into(), alice.last_played), (a.mu, a.phi, 1001));
    assert_eq!((bob.mu.into(), bob.phi.into(), bob.last_played), (b.mu, b.phi, 1001));
    assert_eq!((alice.wins, bob.losses), (1, 1));
    assert_eq!(ratings.player(BLITZ, ALICE()), alice);
    assert_eq!(ratings.ticket_status(ticket_digest(ratings, @ticket)), (RATED, terms.game_id));
    // Rating in blitz leaves rapid alone.
    assert_eq!(ratings.player(RAPID, ALICE()).games, 0);
}

#[test]
fn a_resignation_before_any_stamp_is_dated_by_its_ticket_and_rates_the_loser() {
    let (game, ratings, world) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = open_rated(game, ratings, ticket, keys());
    set_block_timestamp(SETTLED_AT);
    caller(ALICE());
    game.resign(terms.game_id);
    let settlement: Settlement = world.read_model(terms.game_id);
    assert_eq!(settlement.via, VIA_RESIGN);
    let (result, alice, bob) = game.rate(terms.game_id, ticket).unwrap();
    assert_eq!((result.played_at, result.steps, result.winner), (ISSUED, 0, 2));
    assert!(result.onchain_forfeit);
    // A short onchain forfeit counts only for the loser.
    assert_eq!((alice.losses, alice.last_played), (1, ISSUED));
    assert_eq!((bob.games, bob.phi), (0, 0));
}

#[test]
fn rating_waits_for_the_settlement() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = open_rated(game, ratings, ticket, keys());
    assert!(game.rate(terms.game_id, ticket).is_none());
    let digest = ticket_digest(ratings, @ticket);
    assert_eq!(ratings.ticket_status(digest), (ACCEPTED, terms.game_id));
}

#[test]
fn an_unrated_game_is_never_rated() {
    let (game, ratings, _) = setup();
    let terms = terms_for(game, keys(), TARGET, 0);
    game.open_game(terms, signed_by_both(@terms));
    caller(ALICE());
    game.resign(terms.game_id);
    assert!(game.rate(terms.game_id, ticket_for(game, BLITZ)).is_none());
    assert_eq!(ratings.player(BLITZ, ALICE()).games, 0);
}

#[test]
#[should_panic(expected: ('Not the game ticket', 'ENTRYPOINT_FAILED'))]
fn a_game_is_rated_under_its_own_ticket() {
    let (game, ratings, _) = setup();
    let ticket = ticket_for(game, BLITZ);
    let terms = open_rated(game, ratings, ticket, keys());
    caller(ALICE());
    game.resign(terms.game_id);
    let _ = game.rate(terms.game_id, Ticket { nonce: 2, ..ticket });
}

#[test]
fn games_in_two_pools_rate_apart() {
    let (game, ratings, _) = setup();
    let blitz = ticket_for(game, BLITZ);
    let first = open_rated(game, ratings, blitz, keys());
    let rapid = Ticket { nonce: 2, ..ticket_for(game, RAPID) };
    let second = open_rated(game, ratings, rapid, other_keys());
    set_block_timestamp(SETTLED_AT);
    caller(ALICE());
    game.resign(first.game_id);
    caller(BOB());
    game.resign(second.game_id);
    game.rate(first.game_id, blitz).unwrap();
    game.rate(second.game_id, rapid).unwrap();
    let (in_blitz, in_rapid) = (ratings.player(BLITZ, ALICE()), ratings.player(RAPID, ALICE()));
    assert_eq!((in_blitz.losses, in_blitz.wins), (1, 0));
    assert_eq!((in_rapid.games, in_rapid.phi), (0, 0));
    let bob = ratings.player(RAPID, BOB());
    assert_eq!((bob.losses, bob.games), (1, 1));
    assert_eq!(ratings.player(BLITZ, BOB()).games, 0);
}


/// A world whose second channel, `rolled_channel`, opens rated games whose
/// referee rolls the dice, under the same ratings contract.
fn rolled_setup() -> (IRolledChannelDispatcher, IRatingsDispatcher, IRatedChannelDispatcher) {
    let (game, ratings, world) = setup();
    let (address, _) = world.dns(@"rolled_channel").unwrap();
    let rolled = IRolledChannelDispatcher { contract_address: address };
    rolled.set_ratings(ratings.contract_address);
    caller(OWNER());
    ratings.set_channel(address, CHANNEL_ACTIVE);
    caller(CAROL());
    (rolled, ratings, game)
}

/// Alice's and Bob's rated blitz game on `rolled`, its clock carrying `tip`.
fn rolled_terms(
    rolled: IRolledChannelDispatcher,
    ratings: IRatingsDispatcher,
    game: IRatedChannelDispatcher,
    tip: felt252,
) -> (Terms<Config>, Ticket) {
    let ticket = Ticket { channel: rolled.contract_address, ..ticket_for(game, BLITZ) };
    let clock = TimeControl { rng_tip: tip, ..blitz_clock().unwrap() };
    let terms = Terms {
        channel: rolled.contract_address.into(),
        clock: Option::Some(clock),
        ..terms_for(game, keys(), TARGET, ticket_digest(ratings, @ticket)),
    };
    (terms, ticket)
}

fn open_rolled(
    rolled: IRolledChannelDispatcher,
    ratings: IRatingsDispatcher,
    terms: Terms<Config>,
    ticket: Ticket,
) {
    let tip = terms.clock.unwrap().rng_tip;
    let referee_signature = if tip == 0 {
        Signature { r: 0, s: 0 }
    } else {
        sign(
            tip_hash::<RatedCounterRules>(terms.chain_id, terms.channel, terms.game_id, tip),
            PK_REF,
        )
    };
    let signatures = signed_by_both(@terms);
    caller(CAROL());
    rolled
        .open_rated_game(
            terms,
            signatures,
            referee_signature,
            ticket,
            sign(ticket_digest(ratings, @ticket), PK_MM),
        );
}

#[test]
fn a_game_rolled_by_its_referee_opens_rated_with_its_tip() {
    let (rolled, ratings, game) = rolled_setup();
    let (terms, ticket) = rolled_terms(rolled, ratings, game, chain_value('rolls', RNG_LEN));
    open_rolled(rolled, ratings, terms, ticket);
    let digest = ticket_digest(ratings, @ticket);
    assert_eq!(ratings.ticket_status(digest), (ACCEPTED, terms.game_id));
}

#[test]
#[should_panic(expected: ('Rated game needs referee rolls', 'ENTRYPOINT_FAILED'))]
fn a_game_rolled_by_its_referee_needs_its_tip() {
    let (rolled, ratings, game) = rolled_setup();
    let (terms, ticket) = rolled_terms(rolled, ratings, game, 0);
    open_rolled(rolled, ratings, terms, ticket);
}
