use arbiter::channel::{ACTIVE, DISPUTE, FORCED, PAUSE_SECONDS, SETTLED};
use arbiter::clocks::{Standard, encode};
use arbiter::{
    Batch, Envelope, Move, REASON_ABANDON, REASON_TIMEOUT, REASON_VOID, REFEREE, Signature, Terms,
    TimeControl, action_hash, actor, apply_steps, checkpoint_hash, context_hash, force, live_hash,
    open, referee_resume_hash, reopen_hash, roll, stamp_hash, state_hash, terms_message, tip_hash,
    void_hash,
};
use arbiter_counter::{ADD, Action, Config, Counter, CounterRules, GAMBLE};
use arbiter_dojo::channel::read;
use arbiter_dojo::models::{
    ChannelGame, ChannelRng, e_ChannelUpdated, m_ChannelRng, m_ChannelState, m_ChannelTerms,
    m_ProverAllowed,
};
use arbiter_testing::{chain_value, public_key, sign};
use core::hash::HashStateTrait;
use core::pedersen::PedersenTrait;
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
use crate::{ICounterChannelDispatcher, ICounterChannelDispatcherTrait, channel};

const PK_A: felt252 = 0x1a2b3c;
const PK_B: felt252 = 0x4d5e6f;
const PK_REF: felt252 = 0x7e7e7e;
const SEED_A: felt252 = 0x5eed0;
const SEED_B: felt252 = 0x5eed1;
const SEED_REF: felt252 = 0x5eed7e;
const RNG_LEN: u32 = 16;
const WINDOW: u32 = 3600;
const TARGET: u8 = 20;
/// Clients choose a game's id before its seats sign the terms.
const GAME_ID: felt252 = 0x6a3e;
/// The wallets' own keys, apart from the per-game session keys.
const WALLET_A: felt252 = 0xa11ce5;
const WALLET_B: felt252 = 0xb0b5;

/// A test wallet (`TestAccount`) deployed from zero with `salt`, at the
/// address Starknet derives for it.
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

fn CAROL() -> ContractAddress {
    'CAROL'.try_into().unwrap()
}

fn caller(address: ContractAddress) {
    set_contract_address(address);
    set_account_contract_address(address);
}

fn setup() -> (ICounterChannelDispatcher, WorldStorage) {
    let ndef = NamespaceDef {
        namespace: "counter",
        resources: [
            TestResource::Model(m_ChannelTerms::TEST_CLASS_HASH),
            TestResource::Model(m_ChannelState::TEST_CLASS_HASH),
            TestResource::Model(m_ChannelRng::TEST_CLASS_HASH),
            TestResource::Model(m_ProverAllowed::TEST_CLASS_HASH),
            TestResource::Event(e_ChannelUpdated::TEST_CLASS_HASH),
            TestResource::Contract(channel::TEST_CLASS_HASH),
        ]
            .span(),
    };
    let defs: Span<ContractDef> = [
        ContractDefTrait::new(@"counter", @"channel")
            .with_writer_of([dojo::utils::bytearray_hash(@"counter")].span()),
    ]
        .span();
    let mut world = spawn_test_world(world::TEST_CLASS_HASH, [ndef].span());
    world.sync_perms_and_inits(defs);
    deploy_wallet('ALICE', WALLET_A);
    deploy_wallet('BOB', WALLET_B);
    let (contract_address, _) = world.dns(@"channel").unwrap();
    (ICounterChannelDispatcher { contract_address }, world)
}

/// World with the channel system trusted as its own "prover", and a game
/// between Alice (seat 0) and Bob (seat 1).
fn started() -> (ICounterChannelDispatcher, WorldStorage, felt252) {
    started_with(Option::None)
}

/// 30 s per turn, a 60 s bank and a 2 s increment, refereed by PK_REF.
fn blitz() -> Option<TimeControl> {
    let settings = Standard {
        turn_ms: 30000, bank_ms: 60000, increment_ms: 2000, byoyomi: Option::None,
    };
    Option::Some(
        TimeControl { referee: public_key(PK_REF), settings: encode(@settings), rng_tip: 0 },
    )
}

/// `blitz`, taking its randomness from the referee: the terms carry the tip of
/// the referee's hash chain.
fn rolled_blitz() -> Option<TimeControl> {
    Option::Some(TimeControl { rng_tip: chain_value(SEED_REF, RNG_LEN), ..blitz().unwrap() })
}

fn no_tip() -> Signature {
    Signature { r: 0, s: 0 }
}

/// Alice (seat 0) and Bob (seat 1) under `clock`, on `game`'s channel.
fn terms_for(game: ICounterChannelDispatcher, clock: Option<TimeControl>) -> Terms<Config> {
    Terms {
        chain_id: get_tx_info().chain_id,
        channel: game.contract_address.into(),
        game_id: GAME_ID,
        prover: game.contract_address.into(),
        response_seconds: WINDOW,
        clock,
        players: array![ALICE().into(), BOB().into()].span(),
        keys: array![public_key(PK_A), public_key(PK_B)].span(),
        rng_tips: array![chain_value(SEED_A, RNG_LEN), chain_value(SEED_B, RNG_LEN)].span(),
        config: Config { target: TARGET },
    }
}

/// Seat `seat`'s wallet signature over `terms`, with the wallet key `key`.
fn wallet_signature(terms: @Terms<Config>, seat: u32, key: felt252) -> Span<felt252> {
    let context = context_hash::<CounterRules>(terms);
    let message = terms_message::<
        CounterRules,
    >(*terms.chain_id, *terms.game_id, context, *terms.players.at(seat));
    let signature = sign(message, key);
    array![signature.r, signature.s].span()
}

/// Both wallets' signatures over `terms`.
fn signed_by_both(terms: @Terms<Config>) -> Span<Span<felt252>> {
    array![wallet_signature(terms, 0, WALLET_A), wallet_signature(terms, 1, WALLET_B)].span()
}

/// The referee's signature over the randomness tip in `terms`, with `key`,
/// for the game `id` (zero when the seats reveal).
fn tip_signature(terms: @Terms<Config>, id: felt252, key: felt252) -> Signature {
    match *terms.clock {
        Option::Some(time) => if time.rng_tip == 0 {
            no_tip()
        } else {
            sign(tip_hash::<CounterRules>(*terms.chain_id, *terms.channel, id, time.rng_tip), key)
        },
        Option::None => no_tip(),
    }
}

/// Open `terms` with both wallets' signatures, sent by Carol: anyone may.
fn open_as_carol(game: ICounterChannelDispatcher, terms: Terms<Config>) {
    caller(CAROL());
    game.open_game(terms, signed_by_both(@terms), tip_signature(@terms, GAME_ID, PK_REF));
}

/// Standard settings that allow `turn_ms` per turn, refereed by `referee`.
fn per_turn(referee: felt252) -> TimeControl {
    let settings = Standard { turn_ms: 30000, bank_ms: 0, increment_ms: 0, byoyomi: Option::None };
    TimeControl { referee, settings: encode(@settings), rng_tip: 0 }
}

fn started_with(clock: Option<TimeControl>) -> (ICounterChannelDispatcher, WorldStorage, felt252) {
    let (game, world) = setup();
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
    open_as_carol(game, terms_for(game, clock));
    caller(BOB());
    (game, world, GAME_ID)
}

/// A world that trusts the channel system as its prover, before any game.
fn trusting() -> ICounterChannelDispatcher {
    let (game, _) = setup();
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
    game
}

fn opening(terms: @Terms<Config>) -> Envelope<Counter> {
    open::<CounterRules>(terms)
}

fn add(amount: u8) -> Move<Action> {
    Move::Play(Action { kind: ADD, amount })
}

/// Sign each step with its seat's key, as a client would, and in a timed game
/// stamp it as the referee would. Returns the batch replay takes (each seat's
/// final signature and the referee's final attestation) and the end state.
fn stamp_steps(
    terms: @Terms<Config>, start: Envelope<Counter>, steps: Span<Move<Action>>, stamps: Span<u64>,
) -> (Batch<Action>, Envelope<Counter>) {
    let context = context_hash::<CounterRules>(terms);
    let mut env = start;
    let mut finals = no_approvals();
    let mut i = 0;
    for step in steps {
        let seat = actor::<CounterRules>(@env, step);
        let message = action_hash::<CounterRules>(context, env.seq, env.transcript, step);
        finals =
            if seat == REFEREE {
                finals
            } else if seat == 0 {
                array![sign(message, PK_A), *finals.at(1)].span()
            } else {
                array![*finals.at(0), sign(message, PK_B)].span()
            };
        let stamp = if stamps.len() == 0 {
            array![].span()
        } else {
            stamps.slice(i, 1)
        };
        env = apply_steps::<CounterRules>(context, terms, env, (), array![*step].span(), stamp);
        i += 1;
    }
    let attestation = match env.clock {
        Option::Some(clock) => sign(
            stamp_hash::<CounterRules>(context, env.seq, env.transcript, @clock), PK_REF,
        ),
        Option::None => Signature { r: 0, s: 0 },
    };
    (Batch { steps, stamps, signatures: finals, attestation }, env)
}

fn sign_steps(
    terms: @Terms<Config>, start: Envelope<Counter>, steps: Span<Move<Action>>,
) -> (Batch<Action>, Envelope<Counter>) {
    stamp_steps(terms, start, steps, array![].span())
}

/// Alice reaches 20 first: 3, 3, 3, 3, 3, 3, then 2.
fn full_game() -> Span<Move<Action>> {
    array![add(3), add(3), add(3), add(3), add(3), add(3), add(2)].span()
}

fn approvals(message: felt252) -> Span<Signature> {
    array![sign(message, PK_A), sign(message, PK_B)].span()
}

fn no_approvals() -> Span<Signature> {
    array![Signature { r: 0, s: 0 }, Signature { r: 0, s: 0 }].span()
}

fn stored(world: @WorldStorage, id: felt252) -> ChannelGame {
    read(world, id)
}

/// Dispute from the opening anchor and resolve into forced play (epoch 1).
fn forced_play() -> (ICounterChannelDispatcher, WorldStorage, felt252) {
    let (game, world, id) = started();
    caller(ALICE());
    game.open_dispute(id, 0);
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    (game, world, id)
}

#[test]
fn opening_fixes_context_and_opening_anchor() {
    let (game, world, id) = started();
    let terms = game.terms(id);
    let channel = stored(@world, id);
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.context, context_hash::<CounterRules>(@terms));
    assert_eq!(channel.anchor.hash, state_hash::<CounterRules>(@opening(@terms)));
    assert_eq!(terms.players, array![ALICE().into(), BOB().into()].span());
    let (mut served, mut model) = (array![], array![]);
    game.get_channel(id).serialize(ref served);
    channel.serialize(ref model);
    assert_eq!(served, model);
}

#[test]
fn a_game_opens_on_its_seats_signed_terms_alone() {
    // Nothing is onchain before it opens.
    let game = trusting();
    let terms = terms_for(game, blitz());
    assert_eq!(get_class_hash_at_syscall(ALICE()).unwrap_syscall().into() != 0, true);
    // Either seat, or anyone, can send it: here Alice, who signed too.
    caller(ALICE());
    game.open_game(terms, signed_by_both(@terms), no_tip());
    let channel = game.get_channel(GAME_ID);
    assert_eq!((channel.status, channel.epoch), (ACTIVE, 0));
    assert_eq!(game.terms(GAME_ID), terms);
}

#[test]
#[should_panic(expected: ('Game already open', 'ENTRYPOINT_FAILED'))]
fn a_game_opens_once() {
    let (game, _, _) = started();
    open_as_carol(game, terms_for(game, Option::None));
}

#[test]
#[should_panic(expected: ('Invalid wallet signature', 'ENTRYPOINT_FAILED'))]
fn every_seats_wallet_must_sign() {
    let game = trusting();
    let terms = terms_for(game, Option::None);
    // Alice's wallet signs Bob's message: Bob never agreed.
    let signatures = array![
        wallet_signature(@terms, 0, WALLET_A), wallet_signature(@terms, 1, WALLET_A),
    ];
    game.open_game(terms, signatures.span(), no_tip());
}

#[test]
#[should_panic(expected: ('Invalid wallet signature', 'ENTRYPOINT_FAILED'))]
fn signatures_over_other_terms_do_not_open_a_game() {
    let game = trusting();
    let signed = terms_for(game, Option::None);
    let terms = Terms { config: Config { target: TARGET + 1 }, ..signed };
    game.open_game(terms, signed_by_both(@signed), no_tip());
}

#[test]
#[should_panic(expected: ('Wrong channel', 'ENTRYPOINT_FAILED'))]
fn terms_for_another_channel_do_not_open_here() {
    let game = trusting();
    let terms = Terms { channel: 'OTHER', ..terms_for(game, Option::None) };
    game.open_game(terms, signed_by_both(@terms), no_tip());
}

#[test]
#[should_panic(expected: ('Wrong chain', 'ENTRYPOINT_FAILED'))]
fn terms_for_another_chain_do_not_open_here() {
    let game = trusting();
    let terms = Terms { chain_id: 'SN_OTHER', ..terms_for(game, Option::None) };
    game.open_game(terms, signed_by_both(@terms), no_tip());
}

#[test]
#[should_panic(expected: ('Invalid game id', 'ENTRYPOINT_FAILED'))]
fn a_game_id_is_never_zero() {
    let game = trusting();
    let terms = Terms { game_id: 0, ..terms_for(game, Option::None) };
    game.open_game(terms, signed_by_both(@terms), no_tip());
}

#[test]
#[should_panic(expected: ('Shared session key', 'ENTRYPOINT_FAILED'))]
fn seats_do_not_share_a_session_key() {
    let game = trusting();
    let keys = array![public_key(PK_A), public_key(PK_A)].span();
    let terms = Terms { keys, ..terms_for(game, Option::None) };
    game.open_game(terms, signed_by_both(@terms), no_tip());
}

#[test]
#[should_panic(expected: ('Invalid tip', 'ENTRYPOINT_FAILED'))]
fn seats_do_not_share_a_randomness_tip() {
    let game = trusting();
    let tip = chain_value(SEED_A, RNG_LEN);
    let terms = Terms { rng_tips: array![tip, tip].span(), ..terms_for(game, Option::None) };
    game.open_game(terms, signed_by_both(@terms), no_tip());
}

#[test]
#[should_panic(expected: ('Invalid players', 'ENTRYPOINT_FAILED'))]
fn one_wallet_takes_one_seat() {
    let game = trusting();
    let players = array![ALICE().into(), ALICE().into()].span();
    let terms = Terms { players, ..terms_for(game, Option::None) };
    let signatures = array![
        wallet_signature(@terms, 0, WALLET_A), wallet_signature(@terms, 1, WALLET_A),
    ];
    game.open_game(terms, signatures.span(), no_tip());
}

#[test]
#[should_panic(expected: ('Unknown channel', 'ENTRYPOINT_FAILED'))]
fn an_unopened_game_has_no_channel() {
    let game = trusting();
    game.get_channel(GAME_ID);
}

#[test]
fn cosigned_game_settles_in_one_transaction() {
    let (game, world, id) = started();
    let terms = game.terms(id);
    let start = opening(@terms);
    let (batch, end) = sign_steps(@terms, start, full_game());
    let context = context_hash::<CounterRules>(@terms);
    let acks = approvals(
        checkpoint_hash::<CounterRules>(context, 0, state_hash::<CounterRules>(@end)),
    );
    // Anyone may submit, e.g. a keeper.
    caller(CAROL());
    game.submit_history(id, 0, start, batch, acks);
    let channel = stored(@world, id);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.winner, 1); // Alice, seat 0
    assert_eq!(channel.anchor.hash, state_hash::<CounterRules>(@end));
}

#[test]
fn unapproved_result_settles_after_the_window() {
    let (game, world, id) = started();
    let terms = game.terms(id);
    let start = opening(@terms);
    let (batch, _) = sign_steps(@terms, start, full_game());
    caller(ALICE());
    game.submit_history(id, 0, start, batch, no_approvals());
    assert_eq!(stored(@world, id).status, DISPUTE);
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    let channel = stored(@world, id);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.winner, 1);
}

#[test]
fn forced_play_then_timeout() {
    let (game, world, id) = forced_play();
    let terms = game.terms(id);
    assert_eq!(stored(@world, id).status, FORCED);
    // Alice plays her turn onchain; Bob never answers.
    caller(ALICE());
    game.force(id, 1, opening(@terms), array![add(3)].span());
    let channel = stored(@world, id);
    assert_eq!(channel.anchor.due, 1);
    set_block_timestamp(channel.deadline);
    game.claim_timeout(id, 2);
    let channel = stored(@world, id);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.winner, 1);
    // The chain judged it: no referee flagged Bob.
    assert_eq!(channel.result.reason, REASON_ABANDON);
}

#[test]
fn forced_gamble_is_revealed_onchain() {
    let (game, world, id) = forced_play();
    let terms = game.terms(id);
    let context = context_hash::<CounterRules>(@terms);
    let gamble = Move::PlayRandom(
        (Action { kind: GAMBLE, amount: 0 }, chain_value(SEED_A, RNG_LEN - 1)),
    );
    caller(ALICE());
    game.force(id, 1, opening(@terms), array![gamble].span());
    // Bob now owes the reveal.
    assert_eq!(stored(@world, id).anchor.due, 1);
    let after_gamble = apply_steps::<
        CounterRules,
    >(context, @terms, opening(@terms), (), array![gamble].span(), array![].span());
    let reveal = Move::Reveal(chain_value(SEED_B, RNG_LEN - 1));
    caller(BOB());
    game.force(id, 2, after_gamble, array![reveal].span());
    let end = apply_steps::<
        CounterRules,
    >(context, @terms, after_gamble, (), array![reveal].span(), array![].span());
    let channel = stored(@world, id);
    assert_eq!(channel.anchor.hash, state_hash::<CounterRules>(@end));
    assert!(end.game.total >= 1 && end.game.total <= 6);
    assert_eq!(channel.anchor.due, 1); // the roll passed the turn to Bob
}

#[test]
fn every_seat_can_resume_offchain_play() {
    let (game, world, id) = forced_play();
    let terms = game.terms(id);
    let context = context_hash::<CounterRules>(@terms);
    let anchor = stored(@world, id).anchor.hash;
    game.resume(id, 1, approvals(reopen_hash::<CounterRules>(context, 1, anchor)));
    assert_eq!(stored(@world, id).status, ACTIVE);
}

#[test]
#[should_panic(expected: ('Untrusted prover class', 'ENTRYPOINT_FAILED'))]
fn untrusted_prover_rejected() {
    let (game, _) = setup();
    open_as_carol(game, terms_for(game, Option::None));
}

#[test]
#[should_panic(expected: ('Only namespace owner', 'ENTRYPOINT_FAILED'))]
fn only_the_owner_allows_provers() {
    let (game, _) = setup();
    caller(ALICE());
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
}

#[test]
#[should_panic(expected: ('Wrong anchor state', 'ENTRYPOINT_FAILED'))]
fn replay_must_start_from_the_anchor() {
    let (game, _, id) = started();
    let terms = game.terms(id);
    let (batch, end) = sign_steps(@terms, opening(@terms), full_game());
    game.submit_history(id, 0, end, batch, no_approvals());
}

#[test]
#[should_panic(expected: ('Not a player', 'ENTRYPOINT_FAILED'))]
fn outsiders_cannot_dispute() {
    let (game, _, id) = started();
    caller(CAROL());
    game.open_dispute(id, 0);
}

#[test]
#[should_panic(expected: ('Not your step', 'ENTRYPOINT_FAILED'))]
fn forced_steps_must_be_the_callers() {
    let (game, _, id) = forced_play();
    let terms = game.terms(id);
    caller(BOB());
    game.force(id, 1, opening(@terms), array![add(3)].span());
}

/// Stamps for `full_game`: each seat answers within its turn allowance.
fn blitz_stamps() -> Span<u64> {
    array![1000, 11000, 21000, 31000, 41000, 51000, 61000].span()
}

#[test]
fn timed_terms_carry_the_time_control() {
    let (game, world, id) = started_with(blitz());
    let terms = game.terms(id);
    assert_eq!(terms.clock, blitz());
    assert_eq!(stored(@world, id).context, context_hash::<CounterRules>(@terms));
    assert!(opening(@terms).clock.is_some());
}

#[test]
fn stamped_game_settles_in_one_transaction() {
    let (game, world, id) = started_with(blitz());
    let terms = game.terms(id);
    let start = opening(@terms);
    let (batch, end) = stamp_steps(@terms, start, full_game(), blitz_stamps());
    let context = context_hash::<CounterRules>(@terms);
    let acks = approvals(
        checkpoint_hash::<CounterRules>(context, 0, state_hash::<CounterRules>(@end)),
    );
    caller(CAROL());
    game.submit_history(id, 0, start, batch, acks);
    let channel = stored(@world, id);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.winner, 1);
}

#[test]
fn the_channel_keeps_when_the_game_started() {
    let (game, world, id) = started_with(blitz());
    let terms = game.terms(id);
    let start = opening(@terms);
    assert_eq!(stored(@world, id).started, 0);
    // A candidate of the first four steps, stamped from 1 s: the game started at 1 s.
    let steps = full_game();
    let (first, middle) = stamp_steps(@terms, start, steps.slice(0, 4), blitz_stamps().slice(0, 4));
    caller(CAROL());
    game.submit_history(id, 0, start, first, no_approvals());
    assert_eq!(stored(@world, id).started, 1);
    // Extending it keeps that start.
    let (rest, _) = stamp_steps(@terms, middle, steps.slice(4, 3), blitz_stamps().slice(4, 3));
    game.submit_history(id, 0, middle, rest, no_approvals());
    let channel = stored(@world, id);
    assert_eq!((channel.candidate.seq, channel.started), (7, 1));
    assert_eq!(game.get_channel(id).started, 1);
}

#[test]
fn an_untimed_game_has_no_start() {
    let (game, world, id) = started();
    let terms = game.terms(id);
    let start = opening(@terms);
    let (batch, _) = stamp_steps(@terms, start, full_game(), array![].span());
    caller(CAROL());
    game.submit_history(id, 0, start, batch, no_approvals());
    assert_eq!(stored(@world, id).started, 0);
}

#[test]
fn flagged_seat_loses_after_the_window() {
    let (game, world, id) = started_with(blitz());
    let terms = game.terms(id);
    let start = opening(@terms);
    // Alice moves; Bob lets his 30 s allowance and 60 s bank run out.
    let steps = array![add(3), Move::Flag].span();
    let (batch, _) = stamp_steps(@terms, start, steps, array![1000, 91001].span());
    caller(ALICE());
    game.submit_history(id, 0, start, batch, no_approvals());
    assert_eq!(stored(@world, id).status, DISPUTE);
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    let channel = stored(@world, id);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.winner, 1); // Alice, seat 0
    assert_eq!(channel.result.reason, REASON_TIMEOUT);
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn stamps_need_the_referees_attestation() {
    let (game, _, id) = started_with(blitz());
    let terms = game.terms(id);
    let start = opening(@terms);
    let (batch, end) = stamp_steps(@terms, start, full_game(), blitz_stamps());
    let context = context_hash::<CounterRules>(@terms);
    let clock = end.clock.unwrap();
    // Signed by a seat instead of the referee.
    let forged = sign(stamp_hash::<CounterRules>(context, end.seq, end.transcript, @clock), PK_A);
    game.submit_history(id, 0, start, Batch { attestation: forged, ..batch }, no_approvals());
}

#[test]
fn forced_play_pauses_the_clock() {
    let (game, _, id) = started_with(blitz());
    caller(ALICE());
    game.open_dispute(id, 0);
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    let terms = game.terms(id);
    let context = context_hash::<CounterRules>(@terms);
    game.force(id, 1, opening(@terms), array![add(3)].span());
    let end = force::<CounterRules>(context, @terms, opening(@terms), (), 0, array![add(3)].span());
    assert_eq!(end.clock.unwrap().stamp, 0);
    assert_eq!(game.get_channel(id).anchor.hash, state_hash::<CounterRules>(@end));
}

#[test]
#[should_panic(expected: ('Referee is a seat', 'ENTRYPOINT_FAILED'))]
fn the_referee_is_not_seat_0() {
    let game = trusting();
    open_as_carol(game, terms_for(game, Option::Some(per_turn(public_key(PK_A)))));
}

#[test]
#[should_panic(expected: ('Referee is a seat', 'ENTRYPOINT_FAILED'))]
fn the_referee_is_not_seat_1() {
    let game = trusting();
    open_as_carol(game, terms_for(game, Option::Some(per_turn(public_key(PK_B)))));
}

#[test]
#[should_panic(expected: ('Invalid session key', 'ENTRYPOINT_FAILED'))]
fn the_referee_key_is_a_curve_point() {
    let game = trusting();
    // x = 5 is not on the STARK curve.
    open_as_carol(game, terms_for(game, Option::Some(per_turn(5))));
}

/// A timed game with a dispute Alice opened at time 0.
fn disputed_timed() -> (ICounterChannelDispatcher, WorldStorage, felt252) {
    let (game, world, id) = started_with(blitz());
    caller(ALICE());
    game.open_dispute(id, 0);
    (game, world, id)
}

fn live_signature(game: ICounterChannelDispatcher, id: felt252, key: felt252) -> Signature {
    let context = context_hash::<CounterRules>(@game.terms(id));
    sign(live_hash::<CounterRules>(context, 0, game.get_channel(id).deadline), key)
}

#[test]
fn a_live_referee_keeps_a_dispute_offchain() {
    let (game, world, id) = disputed_timed();
    // Anyone may send the referee's signature.
    caller(CAROL());
    game.acknowledge(id, 0, live_signature(game, id, PK_REF));
    let channel = stored(@world, id);
    assert_eq!((channel.acked_epoch, channel.acked_deadline), (0, WINDOW.into()));
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    let channel = stored(@world, id);
    assert_eq!(channel.status, ACTIVE);
    assert_eq!((channel.epoch, channel.deadline), (1, 0));
}

#[test]
fn without_an_acknowledgement_a_timed_dispute_is_forced() {
    let (game, world, id) = disputed_timed();
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    assert_eq!(stored(@world, id).status, FORCED);
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn only_the_referee_acknowledges() {
    let (game, _, id) = disputed_timed();
    game.acknowledge(id, 0, live_signature(game, id, PK_A));
}

#[test]
#[should_panic(expected: ('Untimed game', 'ENTRYPOINT_FAILED'))]
fn an_untimed_game_has_no_referee_to_acknowledge() {
    let (game, _, id) = started();
    caller(ALICE());
    game.open_dispute(id, 0);
    game.acknowledge(id, 0, live_signature(game, id, PK_REF));
}

#[test]
#[should_panic(expected: ('Dispute window closed', 'ENTRYPOINT_FAILED'))]
fn an_acknowledgement_after_the_window_is_too_late() {
    let (game, _, id) = disputed_timed();
    let signature = live_signature(game, id, PK_REF);
    set_block_timestamp(WINDOW.into());
    game.acknowledge(id, 0, signature);
}

fn referee_resume(
    game: ICounterChannelDispatcher, world: @WorldStorage, id: felt252, key: felt252,
) {
    let context = context_hash::<CounterRules>(@game.terms(id));
    let anchor = stored(world, id).anchor.hash;
    game
        .resume_by_referee(
            id, 1, sign(referee_resume_hash::<CounterRules>(context, 1, anchor), key),
        );
}

#[test]
fn the_referee_alone_returns_a_timed_game_from_forced_play() {
    let (game, world, id) = disputed_timed();
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    // Bob, who would rather stay onchain, need not sign.
    caller(CAROL());
    referee_resume(game, @world, id, PK_REF);
    let channel = stored(@world, id);
    assert_eq!((channel.status, channel.epoch, channel.deadline), (ACTIVE, 2, 0));
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn a_seat_cannot_resume_alone() {
    let (game, world, id) = disputed_timed();
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    referee_resume(game, @world, id, PK_A);
}

#[test]
#[should_panic(expected: ('Untimed game', 'ENTRYPOINT_FAILED'))]
fn an_untimed_game_needs_every_seat_to_resume() {
    let (game, world, id) = forced_play();
    referee_resume(game, @world, id, PK_REF);
}

#[test]
fn segments_extend_the_candidate_within_one_window() {
    let (game, world, id) = started();
    let terms = game.terms(id);
    let start = opening(@terms);
    let steps = full_game();
    // The first four steps open a dispute...
    let (first, middle) = sign_steps(@terms, start, steps.slice(0, 4));
    caller(CAROL());
    game.submit_history(id, 0, start, first, no_approvals());
    let channel = stored(@world, id);
    assert_eq!(channel.candidate.hash, state_hash::<CounterRules>(@middle));
    let (_, _, anchor_hash, _, candidate_hash, _) = game.snapshot(id);
    assert_eq!((anchor_hash, candidate_hash), (channel.anchor.hash, channel.candidate.hash));
    // ...and the rest extends the candidate rather than starting over.
    let (rest, end) = sign_steps(@terms, middle, steps.slice(4, 3));
    game.submit_history(id, 0, middle, rest, no_approvals());
    assert_eq!(stored(@world, id).candidate.hash, state_hash::<CounterRules>(@end));
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    let channel = stored(@world, id);
    assert_eq!((channel.status, channel.result.winner), (SETTLED, 1));
}

#[test]
fn channel_state_packs_and_unpacks_exactly() {
    let big = arbiter_dojo::models::StoredOutcome { finished: true, winner: 255, reason: 255 };
    let r = |
        hash: felt252, seq: u32,
    | arbiter::channel::StateRef {
        hash,
        seq,
        support_turn: 0xffffffff,
        due: 255,
        outcome: arbiter::Outcome {
            finished: big.finished, winner: big.winner, reason: big.reason,
        },
    };
    let max40: u64 = 0xffffffffff;
    let channel = arbiter::Channel {
        status: 255,
        epoch: 0xffffffff,
        context: 0,
        response_seconds: 604800,
        anchor: r(0xa, 0xffffffff),
        candidate: r(0xc, 7),
        anchor_block: max40,
        candidate_block: max40 - 1,
        deadline: max40 - 2,
        acked_epoch: 0xfffffffe,
        acked_deadline: max40 - 3,
        referee_rng: true,
        started: 0x3ffffffff,
        result: arbiter::Outcome { finished: true, winner: 254, reason: 253 },
    };
    let packed = arbiter_dojo::models::pack_state(1, @channel);
    assert_eq!(arbiter_dojo::models::unpack_state(@packed, 0, 604800), channel);
    // The one bit that says the referee gives the randomness stands alone.
    let seats = arbiter::Channel { referee_rng: false, ..channel };
    let packed = arbiter_dojo::models::pack_state(1, @seats);
    assert_eq!(arbiter_dojo::models::unpack_state(@packed, 0, 604800), seats);
    // A candidate that is the anchor is stored as zero, and read back as the anchor.
    let same = arbiter::Channel { candidate: channel.anchor, ..channel };
    let packed = arbiter_dojo::models::pack_state(1, @same);
    assert_eq!(packed.candidate, 0);
    assert_eq!(arbiter_dojo::models::unpack_state(@packed, 0, 604800), same);
}

#[test]
#[should_panic(expected: 'Value exceeds 34 bits')]
fn starts_past_34_bits_are_refused() {
    let opening = arbiter::channel::StateRef {
        hash: 0xa,
        seq: 0,
        support_turn: 0,
        due: 0,
        outcome: arbiter::Outcome { finished: false, winner: 0, reason: 0 },
    };
    let empty = arbiter::channel::open(1, opening, 3600, false, 0);
    let channel = arbiter::Channel { started: 0x400000000, ..empty };
    arbiter_dojo::models::pack_state(1, @channel);
}

#[test]
#[should_panic(expected: 'Value exceeds 40 bits')]
fn block_numbers_past_40_bits_are_refused() {
    let opening = arbiter::channel::StateRef {
        hash: 0xa,
        seq: 0,
        support_turn: 0,
        due: 0,
        outcome: arbiter::Outcome { finished: false, winner: 0, reason: 0 },
    };
    let empty = arbiter::channel::open(1, opening, 3600, false, 0);
    let channel = arbiter::Channel { anchor_block: 0x10000000000, ..empty };
    arbiter_dojo::models::pack_state(1, @channel);
}

// ---- Randomness from the referee ----

fn gamble() -> Span<Move<Action>> {
    array![Move::PlayRandom((Action { kind: GAMBLE, amount: 0 }, chain_value(SEED_A, RNG_LEN - 1)))]
        .span()
}

/// Forced play in which Alice gambled onchain: the channel waits for the
/// referee's roll (epoch 2). Also returns the anchor's state.
fn paused() -> (ICounterChannelDispatcher, WorldStorage, felt252, Envelope<Counter>) {
    let (game, world, id) = started_with(rolled_blitz());
    caller(ALICE());
    game.open_dispute(id, 0);
    set_block_timestamp(WINDOW.into());
    game.resolve(id, 0);
    let terms = game.terms(id);
    game.force(id, 1, opening(@terms), gamble());
    let context = context_hash::<CounterRules>(@terms);
    let waiting = force::<CounterRules>(context, @terms, opening(@terms), (), 0, gamble());
    (game, world, id, waiting)
}

#[test]
fn the_referees_signed_tip_joins_the_terms() {
    let (game, world, id) = started_with(rolled_blitz());
    let terms = game.terms(id);
    let tip = chain_value(SEED_REF, RNG_LEN);
    assert_eq!(terms.clock.unwrap().rng_tip, tip);
    assert_eq!(stored(@world, id).referee_tip, tip);
    assert_eq!(stored(@world, id).context, context_hash::<CounterRules>(@terms));
    assert_eq!(opening(@terms).rng_referee, tip);
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn a_tip_the_referee_did_not_sign_is_refused() {
    // Bob's own chain, signed with his own key: he would know every roll.
    let game = trusting();
    let terms = terms_for(game, rolled_blitz());
    caller(BOB());
    game.open_game(terms, signed_by_both(@terms), tip_signature(@terms, GAME_ID, PK_B));
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn a_tip_signed_for_another_game_is_refused() {
    let game = trusting();
    let terms = terms_for(game, rolled_blitz());
    game.open_game(terms, signed_by_both(@terms), tip_signature(@terms, GAME_ID + 1, PK_REF));
}

#[test]
#[should_panic(expected: ('Invalid signature r', 'ENTRYPOINT_FAILED'))]
fn a_referee_tip_needs_the_referees_signature() {
    let game = trusting();
    let terms = terms_for(game, rolled_blitz());
    game.open_game(terms, signed_by_both(@terms), no_tip());
}

#[test]
#[should_panic(expected: ('Seats reveal in this game', 'ENTRYPOINT_FAILED'))]
fn a_referee_signature_without_its_tip_is_refused() {
    // The seats reveal: a signed tip has no place in these terms.
    let game = trusting();
    let terms = terms_for(game, blitz());
    let tip = chain_value(SEED_REF, RNG_LEN);
    let signature = sign(
        tip_hash::<CounterRules>(terms.chain_id, terms.channel, GAME_ID, tip), PK_REF,
    );
    game.open_game(terms, signed_by_both(@terms), signature);
}

#[test]
fn a_forced_gamble_pauses_for_the_referee() {
    let (_, world, id, waiting) = paused();
    let channel = stored(@world, id);
    assert_eq!((channel.status, channel.epoch), (FORCED, 2));
    assert_eq!(channel.anchor.due, REFEREE);
    assert_eq!(channel.anchor.hash, state_hash::<CounterRules>(@waiting));
    assert_eq!(channel.deadline, WINDOW.into() + PAUSE_SECONDS);
}

#[test]
#[should_panic(expected: ('Waiting for the referee', 'ENTRYPOINT_FAILED'))]
fn nobody_times_out_during_the_pause() {
    let (game, world, id, _) = paused();
    set_block_timestamp(stored(@world, id).deadline);
    caller(BOB());
    game.claim_timeout(id, 2);
}

#[test]
fn anyone_posts_the_referees_roll() {
    let (game, world, id, waiting) = paused();
    let terms = game.terms(id);
    let value = chain_value(SEED_REF, RNG_LEN - 1);
    set_block_timestamp(WINDOW.into() + 86400);
    caller(CAROL());
    game.roll(id, 2, waiting, value);
    let end = roll::<
        CounterRules,
    >(context_hash::<CounterRules>(@terms), @terms, waiting, (), value);
    let channel = stored(@world, id);
    assert_eq!((channel.status, channel.epoch), (FORCED, 3));
    assert_eq!(channel.anchor.hash, state_hash::<CounterRules>(@end));
    // The roll passed the turn to Bob, who gets a fresh window.
    assert_eq!(channel.anchor.due, 1);
    assert_eq!(channel.deadline, WINDOW.into() + 86400 + WINDOW.into());
}

#[test]
#[should_panic(expected: ('Invalid reveal', 'ENTRYPOINT_FAILED'))]
fn a_roll_must_be_the_referees_next_value() {
    let (game, _, id, waiting) = paused();
    // Bob's next chain value is not the referee's.
    game.roll(id, 2, waiting, chain_value(SEED_B, RNG_LEN - 1));
}

#[test]
fn a_pause_ends_void_after_three_days() {
    let (game, world, id, _) = paused();
    set_block_timestamp(stored(@world, id).deadline);
    caller(CAROL());
    game.void(id, 2, no_approvals());
    let channel = stored(@world, id);
    assert_eq!((channel.status, channel.result.reason), (SETTLED, REASON_VOID));
    assert_eq!(channel.result.winner, 0);
}

#[test]
#[should_panic(expected: ('Pause still open', 'ENTRYPOINT_FAILED'))]
fn one_seat_cannot_void_a_pause_early() {
    let (game, world, id, _) = paused();
    set_block_timestamp(stored(@world, id).deadline - 1);
    game.void(id, 2, no_approvals());
}

#[test]
fn both_seats_void_a_pause_at_once() {
    let (game, world, id, _) = paused();
    let context = context_hash::<CounterRules>(@game.terms(id));
    let anchor = stored(@world, id).anchor.hash;
    caller(CAROL());
    game.void(id, 2, approvals(void_hash::<CounterRules>(context, 2, anchor)));
    let channel = stored(@world, id);
    assert_eq!((channel.status, channel.result.reason), (SETTLED, REASON_VOID));
}

#[test]
fn the_referee_takes_a_paused_game_back() {
    let (game, world, id, waiting) = paused();
    let context = context_hash::<CounterRules>(@game.terms(id));
    let anchor = state_hash::<CounterRules>(@waiting);
    caller(CAROL());
    game
        .resume_by_referee(
            id, 2, sign(referee_resume_hash::<CounterRules>(context, 2, anchor), PK_REF),
        );
    // Offchain again, where the referee rolls.
    let channel = stored(@world, id);
    assert_eq!((channel.status, channel.anchor.due), (ACTIVE, REFEREE));
}

/// The referee's tip as stored, apart from the terms.
fn stored_tip(world: @WorldStorage, id: felt252) -> felt252 {
    let rng: ChannelRng = world.read_model(id);
    rng.tip
}

#[test]
fn only_a_game_that_asks_stores_a_referee_tip() {
    // Seats reveal, timed or not: nothing is written, and nothing is read back.
    let (_, world, id) = started_with(blitz());
    assert_eq!(stored_tip(@world, id), 0);
    assert_eq!(stored(@world, id).referee_tip, 0);
    // The terms take the referee's randomness: the tip the referee signed.
    let (_, world, id) = started_with(rolled_blitz());
    assert_eq!(stored_tip(@world, id), chain_value(SEED_REF, RNG_LEN));
}

#[test]
fn the_referee_tip_stays_with_the_game_through_forced_play() {
    // Every transition rewrites the packed state: the tip must still be found.
    let (game, world, id, _) = paused();
    let tip = chain_value(SEED_REF, RNG_LEN);
    assert_eq!(stored(@world, id).referee_tip, tip);
    assert_eq!(game.terms(id).clock.unwrap().rng_tip, tip);
    set_block_timestamp(stored(@world, id).deadline);
    game.void(id, 2, no_approvals());
    assert_eq!(stored(@world, id).referee_tip, tip);
}
