use dojo::world::{WorldStorage, WorldStorageTrait, world};
use dojo_cairo_test::{
    ContractDef, ContractDefTrait, NamespaceDef, TestResource, WorldStorageTestTrait,
    spawn_test_world,
};
use referee::channel::{ACTIVE, DISPUTE, FORCED, SETTLED};
use referee::clocks::{Standard, encode};
use referee::{
    Batch, Envelope, Move, REASON_ABANDON, REASON_TIMEOUT, REFEREE, Signature, Terms, TimeControl,
    action_hash, actor, apply_steps, checkpoint_hash, context_hash, force, live_hash, open,
    referee_resume_hash, reopen_hash, stamp_hash, state_hash,
};
use referee_counter::{ADD, Action, Config, Counter, CounterRules, GAMBLE};
use referee_dojo::channel::read;
use referee_dojo::models::{
    ChannelGame, e_ChannelUpdated, m_ChannelState, m_ChannelTerms, m_ProverAllowed,
};
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
            TestResource::Model(m_ChannelTerms::TEST_CLASS_HASH),
            TestResource::Model(m_ChannelState::TEST_CLASS_HASH),
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
    let settings = Standard {
        turn_ms: 30000, bank_ms: 60000, increment_ms: 2000, byoyomi: Option::None,
    };
    Option::Some(TimeControl { referee: public_key(PK_REF), settings: encode(@settings) })
}

/// Standard settings that allow `turn_ms` per turn, refereed by `referee`.
fn per_turn(referee: felt252) -> TimeControl {
    let settings = Standard { turn_ms: 30000, bank_ms: 0, increment_ms: 0, byoyomi: Option::None };
    TimeControl { referee, settings: encode(@settings) }
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
    let clock = per_turn(public_key(PK_A));
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
    let clock = per_turn(5);
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
    let big = referee_dojo::models::StoredOutcome { finished: true, winner: 255, reason: 255 };
    let r = |
        hash: felt252, seq: u32,
    | referee::channel::StateRef {
        hash,
        seq,
        support_turn: 0xffffffff,
        due: 255,
        outcome: referee::Outcome {
            finished: big.finished, winner: big.winner, reason: big.reason,
        },
    };
    let max40: u64 = 0xffffffffff;
    let channel = referee::Channel {
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
        result: referee::Outcome { finished: true, winner: 254, reason: 253 },
    };
    let packed = referee_dojo::models::pack_state(1, @channel);
    assert_eq!(referee_dojo::models::unpack_state(@packed, 0, 604800), channel);
    // A candidate that is the anchor is stored as zero, and read back as the anchor.
    let same = referee::Channel { candidate: channel.anchor, ..channel };
    let packed = referee_dojo::models::pack_state(1, @same);
    assert_eq!(packed.candidate, 0);
    assert_eq!(referee_dojo::models::unpack_state(@packed, 0, 604800), same);
}

#[test]
#[should_panic(expected: 'Value exceeds 40 bits')]
fn block_numbers_past_40_bits_are_refused() {
    let empty = referee::channel::create(3600);
    let channel = referee::Channel { anchor_block: 0x10000000000, ..empty };
    referee_dojo::models::pack_state(1, @channel);
}
