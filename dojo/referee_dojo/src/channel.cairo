//! Entrypoint implementations for a game's Dojo system. Each wraps the pure
//! state machine in `referee::channel` with storage, caller authentication,
//! prover checks and signature checks. A game system calls one helper per
//! entrypoint, e.g. `referee_dojo::channel::open_game::<MyRules>(ref world, ...)`.
use core::ec::EcPointTrait;
use core::num::traits::Zero;
use dojo::event::EventStorage;
use dojo::model::{Model, ModelStorage};
use dojo::world::{IWorldDispatcherTrait, WorldStorage};
use referee::{
    Batch, Channel, Envelope, GameRules, Move, Outcome, Signature, Terms, TimeControl, approve_all,
    channel as machine, checkpoint_hash, context_hash, live_hash, open, referee_resume_hash,
    reopen_hash, replay, state_ref, terms_message, tip_hash, verify, void_hash,
};
use starknet::syscalls::{call_contract_syscall, get_class_hash_at_syscall};
use starknet::{
    ContractAddress, SyscallResultTrait, get_block_number, get_block_timestamp, get_caller_address,
    get_contract_address, get_tx_info,
};
use crate::models::{
    ACKNOWLEDGED, ChannelGame, ChannelRng, ChannelState, ChannelTerms, ChannelUpdated, DISPUTED,
    FORCED, OPENED, ProverAllowed, RECEIVED, RESIGNED, RESOLVED, RESUMED, ROLLED, TIMED_OUT, VOIDED,
    channel_of, game_of, pack_state, unpack_state,
};

/// Open a game on its seats' signed terms: each seat's wallet signs
/// `terms_message` (the SDK's `termsTypedData`), and its account must accept
/// the signature (`is_valid_signature`, SNIP-6). Anyone may send it, usually
/// in one transaction with the game's first call that needs the chain, its
/// settlement say. Clients choose the game id, which opens once. A game that
/// takes its randomness from its referee carries the referee's tip in its
/// time control (`rng_tip`), and `referee_signature` is the referee's over it
/// (`tip_hash`): a tip a seat made up would let that seat know every roll.
/// Otherwise `referee_signature` is zero.
pub fn open_game<
    impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>, +Serde<R::State>, +Drop<R::State>,
>(
    ref world: WorldStorage,
    terms: Terms<R::Config>,
    signatures: Span<Span<felt252>>,
    referee_signature: Signature,
) {
    let game_id = terms.game_id;
    let chain_id = get_tx_info().chain_id;
    assert(terms.chain_id == chain_id, 'Wrong chain');
    assert(terms.channel == get_contract_address().into(), 'Wrong channel');
    assert(game_id != 0, 'Invalid game id');
    let stored: ContractAddress = world
        .read_member(Model::<ChannelTerms>::ptr_from_keys(game_id), selector!("player_0"));
    assert(stored.is_zero(), 'Game already open');
    // Checks the seat count, the tips, the time control and the config.
    let opening = open::<R>(@terms);
    assert(terms.players.len() == 2 && terms.keys.len() == 2, 'Wrong seat count');
    assert(signatures.len() == 2, 'Wrong signature count');
    let player_0 = address(*terms.players.at(0));
    let player_1 = address(*terms.players.at(1));
    assert(player_0.is_non_zero() && player_1.is_non_zero(), 'Invalid players');
    assert(player_0 != player_1, 'Invalid players');
    let (key_0, key_1) = (*terms.keys.at(0), *terms.keys.at(1));
    valid_key(key_0);
    valid_key(key_1);
    // One signature would approve for both seats.
    assert(key_0 != key_1, 'Shared session key');
    let (tip_0, tip_1) = (*terms.rng_tips.at(0), *terms.rng_tips.at(1));
    assert(tip_0 != tip_1, 'Invalid tip');
    let prover = address(terms.prover);
    valid_prover(@world, prover);
    let (referee, clock_settings, referee_tip) = match terms.clock {
        Option::Some(time) => {
            valid_key(time.referee);
            assert(time.referee != key_0 && time.referee != key_1, 'Referee is a seat');
            if time.rng_tip != 0 {
                verify(
                    time.referee,
                    tip_hash::<R>(chain_id, terms.channel, game_id, time.rng_tip),
                    referee_signature,
                );
            }
            (time.referee, time.settings, time.rng_tip)
        },
        Option::None => (0, array![].span(), 0),
    };
    let context = context_hash::<R>(@terms);
    let mut seat: u32 = 0;
    for player in terms.players {
        accepted(
            *player, terms_message::<R>(chain_id, game_id, context, *player), *signatures.at(seat),
        );
        seat += 1;
    }
    let mut config = array![];
    terms.config.serialize(ref config);
    world
        .write_model(
            @ChannelTerms {
                id: game_id,
                player_0,
                player_1,
                key_0,
                key_1,
                tip_0,
                tip_1,
                prover,
                config: config.span(),
                context,
                response_seconds: terms.response_seconds,
                referee,
                clock_settings,
            },
        );
    // Only a game that takes its randomness from its referee has one.
    if referee_tip != 0 {
        world.write_model(@ChannelRng { id: game_id, tip: referee_tip });
    }
    let channel = machine::open(
        context,
        state_ref::<R>(@opening),
        terms.response_seconds,
        referee_tip != 0,
        get_block_number(),
    );
    save(ref world, game_id, channel, OPENED);
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

/// Post the referee's value for the roll the anchor waits for, during forced
/// play. Anyone may: the referee's hash chain vouches for the value, so it
/// needs no signature. The next seat gets a fresh window.
pub fn roll<
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
    value: felt252,
) {
    let game = read(@world, game_id);
    assert(state_ref::<R>(@start).hash == game.anchor.hash, 'Wrong anchor state');
    let terms = terms::<R>(@game);
    let end = referee::roll::<R>(game.context, @terms, start, witness, value);
    let channel = machine::rolled(
        channel_of(@game), epoch, state_ref::<R>(@end), get_block_timestamp(), get_block_number(),
    );
    save(ref world, game_id, channel, ROLLED);
}

/// End a game whose roll waits for a referee that is down, with no result
/// (`REASON_VOID`): at once with every seat's approval (`void_hash`), or by
/// anyone once the pause has run out.
pub fn void<impl R: GameRules>(
    ref world: WorldStorage, game_id: felt252, epoch: u32, acks: Span<Signature>,
) {
    let channel = read_state(@world, game_id);
    let terms = Model::<ChannelTerms>::ptr_from_keys(game_id);
    let key_0: felt252 = world.read_member(terms, selector!("key_0"));
    let key_1: felt252 = world.read_member(terms, selector!("key_1"));
    let context: felt252 = world.read_member(terms, selector!("context"));
    let approved = approve_all(
        array![key_0, key_1].span(), void_hash::<R>(context, epoch, channel.anchor.hash), acks,
    );
    let channel = machine::void(channel, epoch, approved, get_block_timestamp());
    save(ref world, game_id, channel, VOIDED);
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
            Option::Some(
                TimeControl {
                    referee: *game.referee,
                    settings: *game.clock_settings,
                    rng_tip: *game.referee_tip,
                },
            )
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

/// A channel's terms and state together, with the referee's tip if the game
/// takes its randomness from its referee.
pub fn read(world: @WorldStorage, game_id: felt252) -> ChannelGame {
    let terms: ChannelTerms = world.read_model(game_id);
    assert(terms.player_0.is_non_zero(), 'Unknown channel');
    let state: ChannelState = world.read_model(game_id);
    let channel = unpack_state(@state, terms.context, terms.response_seconds);
    // Only such a game has a `ChannelRng`: no other pays for reading one.
    let referee_tip = if channel.referee_rng {
        let rng: ChannelRng = world.read_model(game_id);
        rng.tip
    } else {
        0
    };
    game_of(@terms, channel, referee_tip)
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

// The state machine and both seats: what disputes, timeouts and resignations
// need.
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

// A seat's wallet signature over the terms, as its account checks it (SNIP-6):
// `'VALID'`, or 1 from older accounts. An account must be deployed to check.
fn accepted(player: felt252, message: felt252, signature: Span<felt252>) {
    let mut calldata = array![message];
    signature.serialize(ref calldata);
    let result = call_contract_syscall(
        address(player), selector!("is_valid_signature"), calldata.span(),
    )
        .unwrap_syscall();
    assert(result.len() == 1, 'Invalid wallet signature');
    let answer = *result.at(0);
    assert(answer == 'VALID' || answer == 1, 'Invalid wallet signature');
}

fn address(value: felt252) -> ContractAddress {
    value.try_into().expect('Invalid address')
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
