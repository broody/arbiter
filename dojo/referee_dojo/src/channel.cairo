//! Entrypoint implementations for a game's Dojo system. Each wraps the pure
//! state machine in `referee::channel` with storage, caller authentication,
//! prover checks and signature checks. A game system calls one helper per
//! entrypoint, e.g. `referee_dojo::channel::join::<MyRules>(ref world, ...)`.
use core::ec::EcPointTrait;
use core::num::traits::Zero;
use dojo::event::EventStorage;
use dojo::model::ModelStorage;
use dojo::world::{IWorldDispatcherTrait, WorldStorage};
use referee::{
    Batch, Envelope, GameRules, Move, Outcome, Signature, Terms, TimeControl, approve_all,
    channel as machine, check_clock, checkpoint_hash, context_hash, open, reopen_hash, replay,
    state_ref,
};
use starknet::syscalls::get_class_hash_at_syscall;
use starknet::{
    ContractAddress, SyscallResultTrait, get_block_number, get_block_timestamp, get_caller_address,
    get_contract_address, get_tx_info,
};
use crate::models::{
    CANCELLED, CREATED, ChannelGame, ChannelUpdated, DISPUTED, FORCED, JOINED, ProverAllowed,
    RECEIVED, RESIGNED, RESOLVED, RESUMED, TIMED_OUT, channel_of, with_channel,
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
        deadline: 0,
        result: channel.result.into(),
    };
    save(ref world, with_channel(game, channel), CREATED);
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
    save(ref world, with_channel(game, channel), JOINED);
}

pub fn cancel(ref world: WorldStorage, game_id: felt252) {
    let game = read(@world, game_id);
    assert(get_caller_address() == game.player_0, 'Only creator');
    save(ref world, with_channel(game, machine::cancel(channel_of(@game))), CANCELLED);
}

/// Called by the proof adapter after it verified a native proof that replays
/// from the anchor with hash `start_hash` to `end`.
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
    assert(start_hash == game.anchor.hash, 'Wrong proof anchor');
    receive::<R>(ref world, game, epoch, end, acks);
}

/// Replay steps onchain from the anchor, without a prover, against each seat's
/// final signature (zero for a seat with no step) and, in a timed game, the
/// steps' stamps and the referee's attestation.
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
    assert(state_ref::<R>(@start).hash == game.anchor.hash, 'Wrong anchor state');
    let terms = terms::<R>(@game);
    let end = replay::<R>(game.context, @terms, start, witness, batch);
    receive::<R>(ref world, game, epoch, end, acks);
}

pub fn open_dispute(ref world: WorldStorage, game_id: felt252, epoch: u32) {
    let game = read(@world, game_id);
    seat_of(@game, get_caller_address());
    let channel = machine::open_dispute(channel_of(@game), epoch, get_block_timestamp());
    save(ref world, with_channel(game, channel), DISPUTED);
}

pub fn resolve(ref world: WorldStorage, game_id: felt252, epoch: u32) {
    let game = read(@world, game_id);
    let channel = machine::resolve(
        channel_of(@game), epoch, get_block_timestamp(), get_block_number(),
    );
    save(ref world, with_channel(game, channel), RESOLVED);
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
    save(ref world, with_channel(game, channel), FORCED);
}

/// Return to offchain play from forced play with every seat's approval.
pub fn resume<impl R: GameRules>(
    ref world: WorldStorage, game_id: felt252, epoch: u32, acks: Span<Signature>,
) {
    let game = read(@world, game_id);
    let approved = approve_all(
        keys(@game), reopen_hash::<R>(game.context, epoch, game.anchor.hash), acks,
    );
    let channel = machine::resume(
        channel_of(@game), epoch, approved, get_block_timestamp(), get_block_number(),
    );
    save(ref world, with_channel(game, channel), RESUMED);
}

pub fn claim_timeout(ref world: WorldStorage, game_id: felt252, epoch: u32) {
    let game = read(@world, game_id);
    let seat = seat_of(@game, get_caller_address());
    let channel = machine::claim_timeout(channel_of(@game), epoch, seat, get_block_timestamp());
    save(ref world, with_channel(game, channel), TIMED_OUT);
}

pub fn resign(ref world: WorldStorage, game_id: felt252) {
    let game = read(@world, game_id);
    let seat = seat_of(@game, get_caller_address());
    save(ref world, with_channel(game, machine::resign(channel_of(@game), seat)), RESIGNED);
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

/// What the adapter needs to prove from the anchor: terms, epoch, anchor hash
/// and the block the anchor was set in.
pub fn snapshot<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    world: @WorldStorage, game_id: felt252,
) -> (Terms<R::Config>, u32, felt252, u64) {
    let game = read(world, game_id);
    assert(machine::is_live(@channel_of(@game)), 'Channel not live');
    (terms::<R>(@game), game.epoch, game.anchor.hash, game.anchor_block)
}

/// The settled result, if any. Games pay rewards from this.
pub fn result(world: @WorldStorage, game_id: felt252) -> Option<Outcome> {
    let game = read(world, game_id);
    if game.status == machine::SETTLED {
        Option::Some(game.result.into())
    } else {
        Option::None
    }
}

pub fn read(world: @WorldStorage, game_id: felt252) -> ChannelGame {
    let game: ChannelGame = world.read_model(game_id);
    assert(game.player_0.is_non_zero(), 'Unknown channel');
    game
}

pub fn seat_of(game: @ChannelGame, address: ContractAddress) -> u8 {
    if address == *game.player_0 {
        0
    } else {
        assert(address.is_non_zero() && address == *game.player_1, 'Not a player');
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
    save(ref world, with_channel(game, channel), RECEIVED);
}

fn config<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(game: @ChannelGame) -> R::Config {
    let mut data = *game.config;
    Serde::deserialize(ref data).expect('Invalid stored config')
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

fn save(ref world: WorldStorage, game: ChannelGame, kind: u8) {
    world.write_model(@game);
    let state = if game.status == machine::DISPUTE {
        game.candidate
    } else {
        game.anchor
    };
    let outcome = if game.status == machine::SETTLED {
        game.result
    } else {
        state.outcome
    };
    world
        .emit_event(
            @ChannelUpdated {
                game_id: game.id,
                kind,
                epoch: game.epoch,
                seq: state.seq,
                status: game.status,
                deadline: game.deadline,
                state_hash: state.hash,
                winner: outcome.winner,
                reason: outcome.reason,
            },
        );
}
