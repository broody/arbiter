//! Entrypoint implementations for a game's Dojo system. Each wraps the pure
//! state machine in `referee::channel` with storage, caller authentication,
//! prover checks and signature checks. A game system calls one helper per
//! entrypoint, e.g. `referee_dojo::channel::join::<MyRules>(ref world, ...)`.
use core::ec::EcPointTrait;
use core::num::traits::Zero;
use dojo::event::EventStorage;
use dojo::model::{Model, ModelStorage};
use dojo::world::{IWorldDispatcherTrait, WorldStorage};
use referee::{
    Batch, Channel, Envelope, GameRules, Move, Outcome, Signature, Terms, TimeControl, approve_all,
    channel as machine, check_clock, checkpoint_hash, context_hash, live_hash, open,
    referee_resume_hash, reopen_hash, replay, state_ref, verify,
};
use starknet::syscalls::get_class_hash_at_syscall;
use starknet::{
    ContractAddress, SyscallResultTrait, get_block_number, get_block_timestamp, get_caller_address,
    get_contract_address, get_tx_info,
};
use crate::models::{
    ACKNOWLEDGED, CANCELLED, CREATED, ChannelGame, ChannelState, ChannelTerms, ChannelUpdated,
    DISPUTED, FORCED, JOINED, ProverAllowed, RECEIVED, RESIGNED, RESOLVED, RESUMED, TIMED_OUT,
    channel_of, game_of, pack_state, terms_of, unpack_state, with_channel,
};

/// Open a channel as seat 0. `invited` may be zero for an open game. `clock`
/// makes the game timed, with a referee that stamps every step (`None` for an
/// untimed game).
pub fn create<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>, +Drop<R::State>>(
    ref world: WorldStorage,
    config: R::Config,
    invited: ContractAddress,
    session_key: felt252,
    rng_tip: felt252,
    prover: ContractAddress,
    response_seconds: u32,
    clock: Option<TimeControl>,
) -> felt252 {
    valid_key(session_key);
    check_clock::<R>(@clock);
    if let Option::Some(time) = clock {
        valid_key(time.referee);
        assert(time.referee != session_key, 'Referee is a seat');
    }
    assert(rng_tip != 0, 'Invalid tip');
    valid_prover(@world, prover);
    let creator = get_caller_address();
    assert(creator.is_non_zero() && invited != creator, 'Invalid players');
    // Rejects invalid configs up front.
    let _state = R::init(@config);
    let mut serialized = array![];
    config.serialize(ref serialized);
    let id: felt252 = world.dispatcher.uuid().into();
    let channel = machine::create(response_seconds);
    let game = ChannelGame {
        id,
        player_0: creator,
        player_1: invited,
        key_0: session_key,
        key_1: 0,
        tip_0: rng_tip,
        tip_1: 0,
        prover,
        config: serialized.span(),
        status: 0,
        epoch: 0,
        context: 0,
        response_seconds: 0,
        referee: match clock {
            Option::Some(time) => time.referee,
            Option::None => 0,
        },
        clock_settings: match clock {
            Option::Some(time) => time.settings,
            Option::None => array![].span(),
        },
        anchor: channel.anchor.into(),
        candidate: channel.candidate.into(),
        anchor_block: 0,
        candidate_block: 0,
        deadline: 0,
        acked_epoch: 0,
        acked_deadline: 0,
        result: channel.result.into(),
    };
    save_terms(ref world, @with_channel(game, channel));
    save(ref world, id, channel, CREATED);
    id
}

/// Take seat 1. The opening state needs both randomness tips, so the channel's
/// context and anchor are fixed here.
pub fn join<
    impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>, +Serde<R::State>, +Drop<R::State>,
>(
    ref world: WorldStorage, game_id: felt252, session_key: felt252, rng_tip: felt252,
) {
    let mut game = read(@world, game_id);
    let joiner = get_caller_address();
    assert(joiner.is_non_zero() && joiner != game.player_0, 'Invalid players');
    assert(game.player_1.is_zero() || game.player_1 == joiner, 'Not invited');
    valid_key(session_key);
    assert(session_key != game.key_0, 'Shared session key');
    assert(session_key != game.referee, 'Referee is a seat');
    assert(rng_tip != 0 && rng_tip != game.tip_0, 'Invalid tip');
    valid_prover(@world, game.prover);
    game.player_1 = joiner;
    game.key_1 = session_key;
    game.tip_1 = rng_tip;
    let terms = terms::<R>(@game);
    let opening = open::<R>(@terms);
    let channel = machine::join(
        channel_of(@game), context_hash::<R>(@terms), state_ref::<R>(@opening), get_block_number(),
    );
    save_terms(ref world, @with_channel(game, channel));
    save(ref world, game_id, channel, JOINED);
}

pub fn cancel(ref world: WorldStorage, game_id: felt252) {
    let (channel, player_0, _) = read_seats(@world, game_id);
    assert(get_caller_address() == player_0, 'Only creator');
    save(ref world, game_id, machine::cancel(channel), CANCELLED);
}

/// Called by the proof adapter after it verified a native proof that replays
/// from the state with hash `start_hash`, the anchor or the candidate, to `end`.
pub fn accept_verified<impl R: GameRules, +Serde<R::State>, +Drop<R::State>>(
    ref world: WorldStorage,
    game_id: felt252,
    epoch: u32,
    start_hash: felt252,
    end: Envelope<R::State>,
    acks: Span<Signature>,
) {
    let game = read(@world, game_id);
    assert(get_caller_address() == game.prover, 'Only prover');
    valid_prover(@world, game.prover);
    assert(is_base(@game, start_hash), 'Wrong proof anchor');
    receive::<R>(ref world, game, epoch, end, acks);
}

/// Replay steps onchain from the anchor or the candidate, without a prover,
/// against each seat's final signature (zero for a seat with no step) and, in
/// a timed game, the steps' stamps and the referee's attestation. Starting from
/// the candidate extends it, so a long transcript can arrive in segments.
pub fn submit_history<
    impl R: GameRules,
    +Serde<R::Config>,
    +Drop<R::Config>,
    +Serde<R::State>,
    +Copy<R::State>,
    +Drop<R::State>,
    +Serde<R::Action>,
    +Copy<R::Action>,
    +Drop<R::Action>,
    +Drop<R::Witness>,
    +Destruct<R::Scratch>,
>(
    ref world: WorldStorage,
    game_id: felt252,
    epoch: u32,
    start: Envelope<R::State>,
    witness: R::Witness,
    batch: Batch<R::Action>,
    acks: Span<Signature>,
) {
    let game = read(@world, game_id);
    assert(is_base(@game, state_ref::<R>(@start).hash), 'Wrong anchor state');
    let terms = terms::<R>(@game);
    let end = replay::<R>(game.context, @terms, start, witness, batch);
    receive::<R>(ref world, game, epoch, end, acks);
}

pub fn open_dispute(ref world: WorldStorage, game_id: felt252, epoch: u32) {
    let (channel, player_0, player_1) = read_seats(@world, game_id);
    seat_among(player_0, player_1, get_caller_address());
    let channel = machine::open_dispute(channel, epoch, get_block_timestamp());
    save(ref world, game_id, channel, DISPUTED);
}

/// The referee of a timed game shows it is live during a dispute: `resolve`
/// then returns an unfinished game to offchain play instead of forced play.
/// Anyone may send the referee's signature.
pub fn acknowledge<impl R: GameRules>(
    ref world: WorldStorage, game_id: felt252, epoch: u32, signature: Signature,
) {
    let channel = read_state(@world, game_id);
    let (referee, context) = referee_of(@world, game_id);
    assert(referee != 0, 'Untimed game');
    verify(referee, live_hash::<R>(context, epoch, channel.deadline), signature);
    let channel = machine::acknowledge(channel, epoch, get_block_timestamp());
    save(ref world, game_id, channel, ACKNOWLEDGED);
}

pub fn resolve(ref world: WorldStorage, game_id: felt252, epoch: u32) {
    let channel = read_state(@world, game_id);
    let (referee, _) = referee_of(@world, game_id);
    let channel = machine::resolve(
        channel, epoch, get_block_timestamp(), get_block_number(), referee != 0,
    );
    save(ref world, game_id, channel, RESOLVED);
}

/// The due seat plays its steps onchain during forced play. Every step must be
/// the caller's own; the wallet call authenticates them instead of signatures.
/// They carry no stamps, so a timed game's clock pauses.
pub fn force<
    impl R: GameRules,
    +Serde<R::Config>,
    +Drop<R::Config>,
    +Serde<R::State>,
    +Copy<R::State>,
    +Drop<R::State>,
    +Serde<R::Action>,
    +Copy<R::Action>,
    +Drop<R::Action>,
    +Drop<R::Witness>,
    +Destruct<R::Scratch>,
>(
    ref world: WorldStorage,
    game_id: felt252,
    epoch: u32,
    start: Envelope<R::State>,
    witness: R::Witness,
    steps: Span<Move<R::Action>>,
) {
    let game = read(@world, game_id);
    let seat = seat_of(@game, get_caller_address());
    assert(state_ref::<R>(@start).hash == game.anchor.hash, 'Wrong anchor state');
    let terms = terms::<R>(@game);
    let end = referee::force::<R>(game.context, @terms, start, witness, seat, steps);
    let channel = machine::forced(
        channel_of(@game),
        epoch,
        seat,
        state_ref::<R>(@end),
        get_block_timestamp(),
        get_block_number(),
    );
    save(ref world, game_id, channel, FORCED);
}

/// Return to offchain play from forced play with every seat's approval.
pub fn resume<impl R: GameRules>(
    ref world: WorldStorage, game_id: felt252, epoch: u32, acks: Span<Signature>,
) {
    let channel = read_state(@world, game_id);
    let terms = Model::<ChannelTerms>::ptr_from_keys(game_id);
    let key_0: felt252 = world.read_member(terms, selector!("key_0"));
    let key_1: felt252 = world.read_member(terms, selector!("key_1"));
    let context: felt252 = world.read_member(terms, selector!("context"));
    let approved = approve_all(
        array![key_0, key_1].span(), reopen_hash::<R>(context, epoch, channel.anchor.hash), acks,
    );
    let channel = machine::resume(
        channel, epoch, approved, get_block_timestamp(), get_block_number(),
    );
    save(ref world, game_id, channel, RESUMED);
}

/// Return a timed game from forced play to offchain play on its referee's
/// signature alone: forced play is the fallback for a referee that is down, so
/// a seat can't keep a game onchain by refusing to approve. Anyone may send it.
pub fn resume_by_referee<impl R: GameRules>(
    ref world: WorldStorage, game_id: felt252, epoch: u32, signature: Signature,
) {
    let channel = read_state(@world, game_id);
    let (referee, context) = referee_of(@world, game_id);
    assert(referee != 0, 'Untimed game');
    verify(referee, referee_resume_hash::<R>(context, epoch, channel.anchor.hash), signature);
    let channel = machine::resume(channel, epoch, true, get_block_timestamp(), get_block_number());
    save(ref world, game_id, channel, RESUMED);
}

pub fn claim_timeout(ref world: WorldStorage, game_id: felt252, epoch: u32) {
    let (channel, player_0, player_1) = read_seats(@world, game_id);
    let seat = seat_among(player_0, player_1, get_caller_address());
    let channel = machine::claim_timeout(channel, epoch, seat, get_block_timestamp());
    save(ref world, game_id, channel, TIMED_OUT);
}

pub fn resign(ref world: WorldStorage, game_id: felt252) {
    let (channel, player_0, player_1) = read_seats(@world, game_id);
    let seat = seat_among(player_0, player_1, get_caller_address());
    save(ref world, game_id, machine::resign(channel, seat), RESIGNED);
}

/// Accept or revoke a proof adapter class. Namespace owners only.
pub fn allow_prover(ref world: WorldStorage, class_hash: felt252, allowed: bool) {
    assert(
        world.dispatcher.is_owner(world.namespace_hash, get_caller_address()),
        'Only namespace owner',
    );
    world.write_model(@ProverAllowed { class_hash, allowed });
}

pub fn terms<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    game: @ChannelGame,
) -> Terms<R::Config> {
    Terms {
        chain_id: get_tx_info().chain_id,
        channel: get_contract_address().into(),
        game_id: *game.id,
        prover: (*game.prover).into(),
        response_seconds: *game.response_seconds,
        clock: if *game.referee == 0 {
            Option::None
        } else {
            Option::Some(TimeControl { referee: *game.referee, settings: *game.clock_settings })
        },
        players: array![(*game.player_0).into(), (*game.player_1).into()].span(),
        keys: keys(game),
        rng_tips: array![*game.tip_0, *game.tip_1].span(),
        config: config::<R>(game),
    }
}

/// What the adapter needs to prove from: terms, epoch, and the hash and block
/// of each state a proof may start from, the anchor and the candidate (the
/// same state outside a dispute).
pub fn snapshot<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    world: @WorldStorage, game_id: felt252,
) -> (Terms<R::Config>, u32, felt252, u64, felt252, u64) {
    let game = read(world, game_id);
    assert(machine::is_live(@channel_of(@game)), 'Channel not live');
    (
        terms::<R>(@game),
        game.epoch,
        game.anchor.hash,
        game.anchor_block,
        game.candidate.hash,
        game.candidate_block,
    )
}

/// The settled result, if any. Games pay rewards from this.
pub fn result(world: @WorldStorage, game_id: felt252) -> Option<Outcome> {
    let channel = read_state(world, game_id);
    if channel.status == machine::SETTLED {
        Option::Some(channel.result)
    } else {
        Option::None
    }
}

/// A channel's terms and state together.
pub fn read(world: @WorldStorage, game_id: felt252) -> ChannelGame {
    let terms: ChannelTerms = world.read_model(game_id);
    assert(terms.player_0.is_non_zero(), 'Unknown channel');
    let state: ChannelState = world.read_model(game_id);
    game_of(@terms, @state)
}

/// A channel's state machine alone, without reading its terms: its context
/// reads as zero. For callers that need the status, references and result.
pub fn read_state(world: @WorldStorage, game_id: felt252) -> Channel {
    let terms = Model::<ChannelTerms>::ptr_from_keys(game_id);
    let response_seconds: u32 = world.read_member(terms, selector!("response_seconds"));
    let state: ChannelState = world.read_model(game_id);
    unpack_state(@state, 0, response_seconds)
}

/// A channel's status, from its packed state.
pub fn status(world: @WorldStorage, game_id: felt252) -> u8 {
    let times: felt252 = world
        .read_member(Model::<ChannelState>::ptr_from_keys(game_id), selector!("times"));
    let times: u256 = times.into();
    (times.low % 0x100).try_into().unwrap()
}

// The state machine and both seats: what disputes, timeouts, resignations and
// cancellations need.
fn read_seats(
    world: @WorldStorage, game_id: felt252,
) -> (Channel, ContractAddress, ContractAddress) {
    let terms = Model::<ChannelTerms>::ptr_from_keys(game_id);
    let player_0: ContractAddress = world.read_member(terms, selector!("player_0"));
    assert(player_0.is_non_zero(), 'Unknown channel');
    let player_1: ContractAddress = world.read_member(terms, selector!("player_1"));
    (read_state(world, game_id), player_0, player_1)
}

// A timed game's referee key (zero if untimed) and the channel's context.
fn referee_of(world: @WorldStorage, game_id: felt252) -> (felt252, felt252) {
    let terms = Model::<ChannelTerms>::ptr_from_keys(game_id);
    (world.read_member(terms, selector!("referee")), world.read_member(terms, selector!("context")))
}

pub fn seat_of(game: @ChannelGame, address: ContractAddress) -> u8 {
    seat_among(*game.player_0, *game.player_1, address)
}

fn seat_among(
    player_0: ContractAddress, player_1: ContractAddress, address: ContractAddress,
) -> u8 {
    if address == player_0 {
        0
    } else {
        assert(address.is_non_zero() && address == player_1, 'Not a player');
        1
    }
}

fn receive<impl R: GameRules, +Serde<R::State>, +Drop<R::State>>(
    ref world: WorldStorage,
    game: ChannelGame,
    epoch: u32,
    end: Envelope<R::State>,
    acks: Span<Signature>,
) {
    let end = state_ref::<R>(@end);
    let approved = approve_all(
        keys(@game), checkpoint_hash::<R>(game.context, epoch, end.hash), acks,
    );
    let channel = machine::receive(
        channel_of(@game), epoch, end, approved, get_block_timestamp(), get_block_number(),
    );
    save(ref world, game.id, channel, RECEIVED);
}

fn config<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(game: @ChannelGame) -> R::Config {
    let mut data = *game.config;
    Serde::deserialize(ref data).expect('Invalid stored config')
}

// A submission starts from the anchor or extends the candidate.
fn is_base(game: @ChannelGame, hash: felt252) -> bool {
    hash == *game.anchor.hash || hash == *game.candidate.hash
}

fn keys(game: @ChannelGame) -> Span<felt252> {
    array![*game.key_0, *game.key_1].span()
}

fn valid_key(key: felt252) {
    assert(key != 0 && EcPointTrait::new_nz_from_x(key).is_some(), 'Invalid session key');
}

fn valid_prover(world: @WorldStorage, prover: ContractAddress) {
    assert(prover.is_non_zero(), 'Zero prover');
    let class_hash = get_class_hash_at_syscall(prover).unwrap_syscall();
    let entry: ProverAllowed = world.read_model(class_hash);
    assert(entry.allowed, 'Untrusted prover class');
}

// Write a channel's terms, at create and join.
fn save_terms(ref world: WorldStorage, game: @ChannelGame) {
    world.write_model(@terms_of(game));
}

// Write a channel's state and announce the transition.
fn save(ref world: WorldStorage, game_id: felt252, channel: Channel, kind: u8) {
    world.write_model(@pack_state(game_id, @channel));
    let state = if channel.status == machine::DISPUTE {
        channel.candidate
    } else {
        channel.anchor
    };
    let outcome = if channel.status == machine::SETTLED {
        channel.result
    } else {
        state.outcome
    };
    world
        .emit_event(
            @ChannelUpdated {
                game_id,
                kind,
                epoch: channel.epoch,
                seq: state.seq,
                status: channel.status,
                deadline: channel.deadline,
                state_hash: state.hash,
                winner: outcome.winner,
                reason: outcome.reason,
            },
        );
}
