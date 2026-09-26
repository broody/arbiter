use core::dict::{Felt252Dict, Felt252DictTrait};
use core::ecdsa::check_ecdsa_signature;
use core::poseidon::poseidon_hash_span;
use crate::rules::GameRules;
use crate::types::{Envelope, Move, NO_SEAT, Outcome, Pending, REASON_RESIGN, Signature, Terms};

/// Version 2: steps are seat-implicit `Move`s, and replays take one final
/// signature per seat instead of a signature per step.
pub const PROTOCOL_VERSION: felt252 = 2;

// Stark signatures require a message below 2^251. Use an explicit 250-bit mask
// in every language; never reinterpret a field hash as an unrestricted message.
pub fn signing_hash(fields: Span<felt252>) -> felt252 {
    let digest: u256 = poseidon_hash_span(fields).into();
    let high: felt252 = (digest.high & 0x3ffffffffffffffffffffffffffffff).into();
    let low: felt252 = digest.low.into();
    low + high * 0x100000000000000000000000000000000
}

pub fn context_hash<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    terms: @Terms<R::Config>,
) -> felt252 {
    let mut fields = array![
        R::TAG, 'REFEREE_CHANNEL_V1', PROTOCOL_VERSION, R::RULES_VERSION.into(),
    ];
    terms.serialize(ref fields);
    poseidon_hash_span(fields.span())
}

pub fn state_hash<impl R: GameRules, +Serde<R::State>, +Drop<R::State>>(
    env: @Envelope<R::State>,
) -> felt252 {
    let mut fields = array![R::TAG, 'REFEREE_STATE_V1'];
    env.serialize(ref fields);
    poseidon_hash_span(fields.span())
}

/// Message a seat signs for a step. It binds the transcript rather than the
/// full state: state is a deterministic function of the anchor and the
/// transcript, and hashing large game states per step is expensive to prove.
/// The seat is not included: the state determines it (see `actor`).
pub fn action_hash<impl R: GameRules, +Serde<R::Action>, +Drop<R::Action>>(
    context: felt252, seq: u32, transcript: felt252, step: @Move<R::Action>,
) -> felt252 {
    let mut fields = array![R::TAG, 'REFEREE_ACTION_V1', context, seq.into(), transcript];
    step.serialize(ref fields);
    signing_hash(fields.span())
}

pub fn checkpoint_hash<impl R: GameRules>(context: felt252, epoch: u32, state: felt252) -> felt252 {
    signing_hash(array![R::TAG, 'REFEREE_CHECKPOINT_V1', context, epoch.into(), state].span())
}

pub fn reopen_hash<impl R: GameRules>(context: felt252, epoch: u32, state: felt252) -> felt252 {
    signing_hash(array![R::TAG, 'REFEREE_REOPEN_V1', context, epoch.into(), state].span())
}

pub fn verify(key: felt252, message: felt252, signature: Signature) {
    let r: u256 = signature.r.into();
    let s: u256 = signature.s.into();
    let order: u256 = core::ec::stark_curve::ORDER.into();
    assert(
        r > 0 && r < 0x800000000000000000000000000000000000000000000000000000000000000,
        'Invalid signature r',
    );
    assert(s > 0 && s < order, 'Invalid signature s');
    assert(
        check_ecdsa_signature(message, key, signature.r, signature.s), 'Invalid session signature',
    );
}

/// All-zero signatures mean "no approvals" (a unilateral submission). Otherwise
/// every seat must have signed.
pub fn approve_all(keys: Span<felt252>, message: felt252, signatures: Span<Signature>) -> bool {
    assert(keys.len() == signatures.len(), 'Wrong approval count');
    let empty = Signature { r: 0, s: 0 };
    let mut any = false;
    for signature in signatures {
        if *signature != empty {
            any = true;
        }
    }
    if !any {
        return false;
    }
    let mut i: u32 = 0;
    while i < keys.len() {
        verify(*keys.at(i), message, *signatures.at(i));
        i += 1;
    }
    true
}

/// One hash-chain link: a reveal `v` is valid when `rng_next(v)` equals the
/// seat's current head.
pub fn rng_next(value: felt252) -> felt252 {
    poseidon_hash_span(array!['REFEREE_RNG_V1', value].span())
}

/// Seed handed to `GameRules::resolve`. Neither seat can predict it before the
/// second reveal, and neither can bias it because both chains were committed.
pub fn seed<impl R: GameRules>(
    context: felt252, seq: u32, requester: felt252, revealer: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![R::TAG, 'REFEREE_SEED_V1', context, seq.into(), requester, revealer].span(),
    )
}

pub fn open<impl R: GameRules, +Drop<R::State>>(
    config: @R::Config, rng_tips: Span<felt252>,
) -> Envelope<R::State> {
    assert(R::SEATS == 2, 'Only 2 seats supported');
    assert(rng_tips.len() == R::SEATS.into(), 'Wrong tip count');
    for tip in rng_tips {
        assert(*tip != 0, 'Invalid tip');
    }
    Envelope {
        seq: 0,
        transcript: 0,
        support_turn: 0,
        last_seat: NO_SEAT,
        pending: idle(),
        rng_heads: rng_tips,
        outcome: Outcome { finished: false, winner: 0, reason: 0 },
        game: R::init(config),
    }
}

/// Seat due to act, including a pending reveal.
pub fn due<impl R: GameRules>(env: @Envelope<R::State>) -> u8 {
    if *env.pending.active {
        *env.pending.seat
    } else {
        R::due(env.game)
    }
}

/// The seat a step belongs to: `Resign` names it; `Reveal` belongs to the
/// pending seat; every other move to the seat whose turn it is.
pub fn actor<impl R: GameRules>(env: @Envelope<R::State>, step: @Move<R::Action>) -> u8 {
    match step {
        Move::Resign(seat) => *seat,
        Move::Reveal(_) => {
            assert(*env.pending.active, 'No reveal due');
            *env.pending.seat
        },
        _ => {
            assert(!*env.pending.active, 'Reveal pending');
            R::due(env.game)
        },
    }
}

/// Replay steps from `start` against one final signature per seat (a zero
/// signature for a seat with no step in the batch). Each seat's final
/// signature commits through the transcript to every earlier step, and honest
/// clients only sign states they derived from verified steps, so intermediate
/// signatures never need to reach the chain or the proof.
pub fn replay<
    impl R: GameRules,
    +Copy<R::State>,
    +Drop<R::State>,
    +Copy<R::Action>,
    +Drop<R::Action>,
    +Serde<R::Action>,
    +Drop<R::Witness>,
    +Destruct<R::Scratch>,
>(
    context: felt252,
    keys: Span<felt252>,
    config: @R::Config,
    start: Envelope<R::State>,
    witness: R::Witness,
    steps: Span<Move<R::Action>>,
    signatures: Span<Signature>,
) -> Envelope<R::State> {
    assert(keys.len() == R::SEATS.into(), 'Wrong key count');
    assert(signatures.len() == R::SEATS.into(), 'Wrong signature count');
    let mut scratch = R::load(config, @start.game, witness);
    let mut env = start;
    let mut finals: Felt252Dict<felt252> = Default::default();
    for step in steps {
        let (next, seat, message) = advance::<R>(context, config, ref scratch, env, *step);
        env = next;
        finals.insert(seat.into(), message);
    }
    let empty = Signature { r: 0, s: 0 };
    let mut seat: u8 = 0;
    while seat < R::SEATS {
        let message = finals.get(seat.into());
        let signature = *signatures.at(seat.into());
        if message != 0 {
            verify(*keys.at(seat.into()), message, signature);
        } else {
            assert(signature == empty, 'Unexpected signature');
        }
        seat += 1;
    }
    env
}

/// Apply unsigned steps, from any seat. For clients and tools that already
/// verified every signature offchain, and for tests.
pub fn apply_steps<
    impl R: GameRules,
    +Copy<R::State>,
    +Drop<R::State>,
    +Copy<R::Action>,
    +Drop<R::Action>,
    +Serde<R::Action>,
    +Drop<R::Witness>,
    +Destruct<R::Scratch>,
>(
    context: felt252,
    config: @R::Config,
    start: Envelope<R::State>,
    witness: R::Witness,
    steps: Span<Move<R::Action>>,
) -> Envelope<R::State> {
    let mut scratch = R::load(config, @start.game, witness);
    let mut env = start;
    for step in steps {
        let (next, _, _) = advance::<R>(context, config, ref scratch, env, *step);
        env = next;
    }
    env
}

/// Apply unsigned steps that must all belong to `seat`, e.g. a forced onchain
/// turn whose seat the wallet caller authenticates.
pub fn force<
    impl R: GameRules,
    +Copy<R::State>,
    +Drop<R::State>,
    +Copy<R::Action>,
    +Drop<R::Action>,
    +Serde<R::Action>,
    +Drop<R::Witness>,
    +Destruct<R::Scratch>,
>(
    context: felt252,
    config: @R::Config,
    start: Envelope<R::State>,
    witness: R::Witness,
    seat: u8,
    steps: Span<Move<R::Action>>,
) -> Envelope<R::State> {
    let mut scratch = R::load(config, @start.game, witness);
    let mut env = start;
    for step in steps {
        let (next, actor, _) = advance::<R>(context, config, ref scratch, env, *step);
        assert(actor == seat, 'Not your step');
        env = next;
    }
    env
}

/// One step: its seat, its signed message, and the next envelope.
fn advance<
    impl R: GameRules,
    +Copy<R::State>,
    +Drop<R::State>,
    +Copy<R::Action>,
    +Drop<R::Action>,
    +Serde<R::Action>,
    +Destruct<R::Scratch>,
>(
    context: felt252,
    config: @R::Config,
    ref scratch: R::Scratch,
    mut env: Envelope<R::State>,
    step: Move<R::Action>,
) -> (Envelope<R::State>, u8, felt252) {
    assert(!env.outcome.finished, 'Game already finished');
    let seat = actor::<R>(@env, @step);
    assert(seat < R::SEATS, 'Invalid seat');
    let message = action_hash::<R>(context, env.seq, env.transcript, @step);
    match step {
        Move::Play(action) => {
            let (game, request) = R::apply(config, ref scratch, env.game, seat, action);
            assert(request.is_none(), 'Randomness requested');
            env.game = game;
        },
        Move::PlayRandom((
            action, entropy,
        )) => {
            let (game, request) = R::apply(config, ref scratch, env.game, seat, action);
            env.game = game;
            let from = request.expect('Unexpected entropy');
            assert(from != seat && from < R::SEATS, 'Invalid reveal seat');
            env.rng_heads = take_reveal(env.rng_heads, seat, entropy);
            env.pending = Pending { active: true, seat: from, seq: env.seq, entropy };
        },
        Move::Reveal(value) => {
            env.rng_heads = take_reveal(env.rng_heads, seat, value);
            let seed = seed::<R>(context, env.pending.seq, env.pending.entropy, value);
            env.pending = idle();
            env.game = R::resolve(config, ref scratch, env.game, seed);
        },
        Move::Recommit(tip) => {
            assert(tip != 0, 'Invalid tip');
            env.rng_heads = set_head(env.rng_heads, seat, tip);
        },
        Move::Resign(_) => {
            env.pending = idle();
            // Two seats: the other seat (index 1 - seat) wins; winner is seat + 1.
            env.outcome = Outcome { finished: true, winner: 2 - seat, reason: REASON_RESIGN };
        },
    }
    if !env.outcome.finished {
        if let Option::Some((winner, reason)) = R::outcome(@env.game) {
            assert(winner <= R::SEATS, 'Invalid winner');
            assert(reason >= 1 && reason < 128, 'Invalid finish reason');
            env.outcome = Outcome { finished: true, winner, reason };
        }
    }
    if env.last_seat != seat {
        env.support_turn += 1;
    }
    env.last_seat = seat;
    env.seq += 1;
    env.transcript = poseidon_hash_span(array![env.transcript, message].span());
    (env, seat, message)
}

fn idle() -> Pending {
    Pending { active: false, seat: 0, seq: 0, entropy: 0 }
}

fn take_reveal(heads: Span<felt252>, seat: u8, value: felt252) -> Span<felt252> {
    assert(value != 0 && rng_next(value) == *heads.at(seat.into()), 'Invalid reveal');
    set_head(heads, seat, value)
}

fn set_head(heads: Span<felt252>, seat: u8, value: felt252) -> Span<felt252> {
    let mut out = array![];
    let mut i: u32 = 0;
    while i < heads.len() {
        out.append(if i == seat.into() {
            value
        } else {
            *heads.at(i)
        });
        i += 1;
    }
    out.span()
}
