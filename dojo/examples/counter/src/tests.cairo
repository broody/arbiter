use dojo::model::ModelStorage;
use dojo::world::{WorldStorage, WorldStorageTrait, world};
use dojo_cairo_test::{
    ContractDef, ContractDefTrait, NamespaceDef, TestResource, WorldStorageTestTrait,
    spawn_test_world,
};
use referee::channel::{ACTIVE, DISPUTE, FORCED, SETTLED};
use referee::{
    Batch, Envelope, Move, REASON_TIMEOUT, REFEREE, Signature, Terms, TimeControl, action_hash,
    actor, apply_steps, checkpoint_hash, context_hash, force, open, reopen_hash, stamp_hash,
    state_hash,
};
use referee_counter::{ADD, Action, Config, Counter, CounterRules, GAMBLE};
use referee_dojo::models::{ChannelGame, e_ChannelUpdated, m_ChannelGame, m_ProverAllowed};
use referee_testing::{chain_value, public_key, sign};
use starknet::ContractAddress;
use starknet::testing::{set_account_contract_address, set_block_timestamp, set_contract_address};
use crate::{ICounterChannelDispatcher, ICounterChannelDispatcherTrait, channel};

const PK_A: felt252 = 0x1a2b3c;
const PK_B: felt252 = 0x4d5e6f;
const PK_REF: felt252 = 0x7e7e7e;
const SEED_A: felt252 = 0x5eed0;
const SEED_B: felt252 = 0x5eed1;
const RNG_LEN: u32 = 16;
const WINDOW: u32 = 3600;
const TARGET: u8 = 20;

fn ALICE() -> ContractAddress {
    'ALICE'.try_into().unwrap()
}

fn BOB() -> ContractAddress {
    'BOB'.try_into().unwrap()
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
            TestResource::Model(m_ChannelGame::TEST_CLASS_HASH),
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
    Option::Some(
        TimeControl {
            referee: public_key(PK_REF), turn_ms: 30000, bank_ms: 60000, increment_ms: 2000,
        },
    )
}

fn started_with(clock: Option<TimeControl>) -> (ICounterChannelDispatcher, WorldStorage, felt252) {
    let (game, world) = setup();
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
    caller(ALICE());
    let id = game
        .create(
            TARGET,
            BOB(),
            public_key(PK_A),
            chain_value(SEED_A, RNG_LEN),
            game.contract_address,
            WINDOW,
            clock,
        );
    caller(BOB());
    game.join(id, public_key(PK_B), chain_value(SEED_B, RNG_LEN));
    (game, world, id)
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
    world.read_model(id)
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
fn join_fixes_context_and_opening_anchor() {
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
    assert_eq!(channel.result.reason, REASON_TIMEOUT);
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
    caller(ALICE());
    game
        .create(
            TARGET,
            BOB(),
            public_key(PK_A),
            chain_value(SEED_A, RNG_LEN),
            game.contract_address,
            WINDOW,
            Option::None,
        );
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
fn the_referee_is_not_the_creator() {
    let (game, _) = setup();
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
    caller(ALICE());
    let clock = TimeControl {
        referee: public_key(PK_A), turn_ms: 30000, bank_ms: 0, increment_ms: 0,
    };
    game
        .create(
            TARGET,
            BOB(),
            public_key(PK_A),
            chain_value(SEED_A, RNG_LEN),
            game.contract_address,
            WINDOW,
            Option::Some(clock),
        );
}

#[test]
#[should_panic(expected: ('Referee is a seat', 'ENTRYPOINT_FAILED'))]
fn the_referee_is_not_the_joiner() {
    let (game, _) = setup();
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
    caller(ALICE());
    let id = game
        .create(
            TARGET,
            BOB(),
            public_key(PK_A),
            chain_value(SEED_A, RNG_LEN),
            game.contract_address,
            WINDOW,
            blitz(),
        );
    caller(BOB());
    game.join(id, public_key(PK_REF), chain_value(SEED_B, RNG_LEN));
}

#[test]
#[should_panic(expected: ('Invalid session key', 'ENTRYPOINT_FAILED'))]
fn the_referee_key_is_a_curve_point() {
    let (game, _) = setup();
    game.allow_prover(channel::TEST_CLASS_HASH.try_into().unwrap(), true);
    caller(ALICE());
    // x = 5 is not on the STARK curve.
    let clock = TimeControl { referee: 5, turn_ms: 30000, bank_ms: 0, increment_ms: 0 };
    game
        .create(
            TARGET,
            BOB(),
            public_key(PK_A),
            chain_value(SEED_A, RNG_LEN),
            game.contract_address,
            WINDOW,
            Option::Some(clock),
        );
}
