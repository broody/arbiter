use referee::{
    Envelope, Move, REASON_RESIGN, SignedStep, Step, approve_all, checkpoint_hash, context_hash,
    force, open, replay, rng_next, state_hash,
};
use crate::fixtures::{
    CHECKPOINT, CONTEXT, RNG_LEN, SEED_0, SEED_1, STATE_HASH, acks, expected, steps, terms,
};
use crate::{ADD, Action, Counter, CounterRules, GAMBLE};

fn start() -> Envelope<Counter> {
    let t = terms();
    open::<CounterRules>(@t.config, t.rng_tips)
}

/// Chain value at `index` (the tip is at RNG_LEN).
fn chain(seed: felt252, index: u32) -> felt252 {
    let mut value = seed;
    let mut i = 0;
    while i < index {
        value = rng_next(value);
        i += 1;
    }
    value
}

fn play(seat: u8, kind: u8, amount: u8, entropy: felt252) -> Step<Action> {
    Step { seat, action: Move::Play(Action { kind, amount }), entropy }
}

fn run_forced(steps: Array<Step<Action>>) -> Envelope<Counter> {
    let t = terms();
    force::<CounterRules>(CONTEXT, @t.config, start(), (), steps.span())
}

#[test]
fn context_hash_matches_sdk() {
    assert_eq!(context_hash::<CounterRules>(@terms()), CONTEXT);
}

#[test]
fn replay_matches_sdk() {
    let t = terms();
    let end = replay::<CounterRules>(CONTEXT, t.keys, @t.config, start(), (), steps().span());
    assert_eq!(end, expected());
    assert_eq!(state_hash::<CounterRules>(@end), STATE_HASH);
}

#[test]
fn checkpoint_approvals_verify() {
    assert_eq!(checkpoint_hash::<CounterRules>(CONTEXT, 0, STATE_HASH), CHECKPOINT);
    assert!(approve_all(terms().keys, CHECKPOINT, acks().span()));
}

#[test]
fn replay_splits_at_any_point() {
    // Replaying a prefix and then the suffix from the prefix's end equals one
    // replay: checkpoints do not change the result.
    let t = terms();
    let all = steps().span();
    let mid = replay::<CounterRules>(CONTEXT, t.keys, @t.config, start(), (), all.slice(0, 4));
    let end = replay::<
        CounterRules,
    >(CONTEXT, t.keys, @t.config, mid, (), all.slice(4, all.len() - 4));
    assert_eq!(end, expected());
}

#[test]
#[should_panic(expected: 'Invalid session signature')]
fn tampered_earlier_step_breaks_final_signature() {
    let t = terms();
    let mut tampered: Array<SignedStep<Action>> = array![];
    let mut first = true;
    for signed in steps() {
        if first {
            // Seat 0's opening ADD 3 becomes ADD 1, keeping the original signature.
            let step = play(0, ADD, 1, 0);
            tampered.append(SignedStep { step, signature: signed.signature });
            first = false;
        } else {
            tampered.append(signed);
        }
    }
    replay::<CounterRules>(CONTEXT, t.keys, @t.config, start(), (), tampered.span());
}

#[test]
fn resign_awards_the_other_seat() {
    let end = run_forced(array![Step { seat: 1, action: Move::Resign, entropy: 0 }]);
    assert!(end.outcome.finished);
    assert_eq!(end.outcome.winner, 1); // seat 0 + 1
    assert_eq!(end.outcome.reason, REASON_RESIGN);
}

#[test]
#[should_panic(expected: 'Not your turn')]
fn out_of_turn_play_rejected() {
    run_forced(array![play(1, ADD, 1, 0)]);
}

#[test]
#[should_panic(expected: 'Invalid reveal')]
fn gamble_requires_the_actors_chain_value() {
    run_forced(array![play(0, GAMBLE, 0, 0x1234)]);
}

#[test]
#[should_panic(expected: 'Invalid reveal')]
fn reveal_must_come_from_the_committed_chain() {
    run_forced(
        array![
            play(0, GAMBLE, 0, chain(SEED_0, RNG_LEN - 1)),
            Step { seat: 1, action: Move::Reveal(0xbad), entropy: 0 },
        ],
    );
}

#[test]
#[should_panic(expected: 'No reveal due')]
fn requester_cannot_reveal_for_the_opponent() {
    run_forced(
        array![
            play(0, GAMBLE, 0, chain(SEED_0, RNG_LEN - 1)),
            Step { seat: 0, action: Move::Reveal(chain(SEED_0, RNG_LEN - 2)), entropy: 0 },
        ],
    );
}

#[test]
#[should_panic(expected: 'Reveal pending')]
fn play_blocks_until_reveal() {
    run_forced(array![play(0, GAMBLE, 0, chain(SEED_0, RNG_LEN - 1)), play(0, ADD, 1, 0)]);
}

#[test]
fn reveal_resolves_the_gamble() {
    let end = run_forced(
        array![
            play(0, GAMBLE, 0, chain(SEED_0, RNG_LEN - 1)),
            Step { seat: 1, action: Move::Reveal(chain(SEED_1, RNG_LEN - 1)), entropy: 0 },
        ],
    );
    assert!(!end.pending.active);
    assert!(end.game.total >= 1 && end.game.total <= 6);
    assert_eq!(end.game.next, 1);
    assert_eq!(end.support_turn, 2);
}

#[test]
#[should_panic(expected: 'Game already finished')]
fn no_steps_after_the_end() {
    run_forced(array![Step { seat: 0, action: Move::Resign, entropy: 0 }, play(0, ADD, 1, 0)]);
}
