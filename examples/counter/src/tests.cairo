use referee::{
    Batch, Envelope, Move, REASON_RESIGN, Signature, apply_steps, approve_all, checkpoint_hash,
    context_hash, force, live_hash, open, referee_resume_hash, replay, rng_next, state_hash,
    terms_message,
};
use crate::fixtures::{
    CHECKPOINT, CONTEXT, LIVE_HASH, REFEREE_RESUME_HASH, RNG_LEN, SEED_0, SEED_1, STATE_HASH,
    TERMS_MESSAGE, acks, expected, finals, signatures, steps, terms,
};
use crate::{ADD, Action, Counter, CounterRules, GAMBLE};

fn start() -> Envelope<Counter> {
    open::<CounterRules>(@terms())
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

fn add(amount: u8) -> Move<Action> {
    Move::Play(Action { kind: ADD, amount })
}

fn gamble(entropy: felt252) -> Move<Action> {
    Move::PlayRandom((Action { kind: GAMBLE, amount: 0 }, entropy))
}

fn run(steps: Array<Move<Action>>) -> Envelope<Counter> {
    apply_steps::<CounterRules>(CONTEXT, @terms(), start(), (), steps.span(), array![].span())
}

/// An untimed batch: no stamps and no attestation.
pub fn batch(steps: Span<Move<Action>>, signatures: Span<Signature>) -> Batch<Action> {
    Batch { steps, stamps: array![].span(), signatures, attestation: Signature { r: 0, s: 0 } }
}

fn replay_all(steps: Span<Move<Action>>, signatures: Array<Signature>) -> Envelope<Counter> {
    replay::<CounterRules>(CONTEXT, @terms(), start(), (), batch(steps, signatures.span()))
}

#[test]
fn context_hash_matches_sdk() {
    assert_eq!(context_hash::<CounterRules>(@terms()), CONTEXT);
}

#[test]
fn replay_matches_sdk() {
    let end = replay_all(steps().span(), finals(0, steps().len()));
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
    let all = steps().span();
    let mid = replay_all(all.slice(0, 4), finals(0, 4));
    let end = replay::<
        CounterRules,
    >(CONTEXT, @terms(), mid, (), batch(all.slice(4, all.len() - 4), finals(4, all.len()).span()));
    assert_eq!(end, expected());
}

#[test]
#[should_panic(expected: 'Invalid session signature')]
fn intermediate_signature_is_not_a_final_one() {
    // Seat 0's first signature, not its last, for the whole game.
    let all = finals(0, steps().len());
    replay_all(steps().span(), array![*signatures().at(0), *all.at(1)]);
}

#[test]
#[should_panic(expected: 'Unexpected signature')]
fn seat_without_steps_signs_nothing() {
    // Step 0 is seat 0's alone; a signature for seat 1 is rejected.
    replay_all(steps().span().slice(0, 1), array![*signatures().at(0), *signatures().at(1)]);
}

#[test]
#[should_panic(expected: 'Wrong signature count')]
fn one_signature_per_seat() {
    replay_all(steps().span(), signatures());
}

#[test]
#[should_panic(expected: 'Invalid session signature')]
fn tampered_earlier_step_breaks_final_signature() {
    let mut tampered: Array<Move<Action>> = array![];
    let mut first = true;
    for step in steps() {
        if first {
            // Seat 0's opening ADD 3 becomes ADD 1 under the original final signatures.
            tampered.append(add(1));
            first = false;
        } else {
            tampered.append(step);
        }
    }
    replay_all(tampered.span(), finals(0, steps().len()));
}

#[test]
fn resign_awards_the_other_seat() {
    let end = run(array![Move::Resign(1)]);
    assert!(end.outcome.finished);
    assert_eq!(end.outcome.winner, 1); // seat 0 + 1
    assert_eq!(end.outcome.reason, REASON_RESIGN);
}

#[test]
#[should_panic(expected: 'Not your step')]
fn forced_steps_belong_to_the_caller() {
    force::<CounterRules>(CONTEXT, @terms(), start(), (), 1, array![add(1)].span());
}

#[test]
fn forced_resignation_names_its_seat() {
    let end = force::<
        CounterRules,
    >(CONTEXT, @terms(), start(), (), 1, array![Move::Resign(1)].span());
    assert_eq!(end.outcome.winner, 1);
}

#[test]
#[should_panic(expected: 'Randomness requested')]
fn randomness_needs_entropy() {
    run(array![Move::Play(Action { kind: GAMBLE, amount: 0 })]);
}

#[test]
#[should_panic(expected: 'Unexpected entropy')]
fn entropy_needs_a_request() {
    run(array![Move::PlayRandom((Action { kind: ADD, amount: 1 }, chain(SEED_0, RNG_LEN - 1)))]);
}

#[test]
#[should_panic(expected: 'Invalid reveal')]
fn gamble_requires_the_actors_chain_value() {
    run(array![gamble(0x1234)]);
}

#[test]
#[should_panic(expected: 'Invalid reveal')]
fn reveal_must_come_from_the_committed_chain() {
    run(array![gamble(chain(SEED_0, RNG_LEN - 1)), Move::Reveal(0xbad)]);
}

#[test]
#[should_panic(expected: 'Not your step')]
fn requester_cannot_reveal_for_the_opponent() {
    // The reveal belongs to seat 1: even its valid value is not seat 0's step.
    force::<
        CounterRules,
    >(
        CONTEXT,
        @terms(),
        start(),
        (),
        0,
        array![gamble(chain(SEED_0, RNG_LEN - 1)), Move::Reveal(chain(SEED_1, RNG_LEN - 1))].span(),
    );
}

#[test]
#[should_panic(expected: 'No reveal due')]
fn reveal_needs_a_request() {
    run(array![Move::Reveal(chain(SEED_0, RNG_LEN - 1))]);
}

#[test]
#[should_panic(expected: 'Reveal pending')]
fn play_blocks_until_reveal() {
    run(array![gamble(chain(SEED_0, RNG_LEN - 1)), add(1)]);
}

#[test]
fn reveal_resolves_the_gamble() {
    let end = run(
        array![gamble(chain(SEED_0, RNG_LEN - 1)), Move::Reveal(chain(SEED_1, RNG_LEN - 1))],
    );
    assert!(!end.pending.active);
    assert!(end.game.total >= 1 && end.game.total <= 6);
    assert_eq!(end.game.next, 1);
    assert_eq!(end.support_turn, 2);
}

#[test]
#[should_panic(expected: 'Game already finished')]
fn no_steps_after_the_end() {
    run(array![Move::Resign(0), add(1)]);
}

#[test]
fn opening_heads_are_fresh() {
    assert_eq!(start().rng_fresh, array![true, true].span());
}

#[test]
#[should_panic(expected: 'Nothing revealed to recommit')]
fn recommit_needs_a_reveal() {
    run(array![Move::Recommit(rng_next(0x5eed2))]);
}

/// Seat 0 gambles and seat 1 reveals: seat 1 is due and has revealed.
fn after_a_reveal() -> Array<Move<Action>> {
    array![gamble(chain(SEED_0, RNG_LEN - 1)), Move::Reveal(chain(SEED_1, RNG_LEN - 1))]
}

#[test]
fn recommit_follows_a_reveal() {
    let mut steps = after_a_reveal();
    steps.append(Move::Recommit(rng_next(0x5eed2)));
    let end = run(steps);
    assert_eq!(end.rng_fresh, array![false, true].span());
    assert_eq!(*end.rng_heads.at(1), rng_next(0x5eed2));
}

#[test]
#[should_panic(expected: 'Nothing revealed to recommit')]
fn one_recommit_per_reveal() {
    let mut steps = after_a_reveal();
    steps.append(Move::Recommit(rng_next(0x5eed2)));
    steps.append(Move::Recommit(rng_next(0x5eed3)));
    run(steps);
}

#[test]
#[should_panic(expected: 'Untimed game')]
fn untimed_games_take_no_start() {
    run(array![Move::Start]);
}

#[test]
#[should_panic(expected: 'Untimed game')]
fn untimed_games_take_no_flag() {
    run(array![Move::Flag]);
}

#[test]
fn referee_messages_match_sdk() {
    assert_eq!(live_hash::<CounterRules>(CONTEXT, 3, 12345), LIVE_HASH);
    assert_eq!(referee_resume_hash::<CounterRules>(CONTEXT, 2, STATE_HASH), REFEREE_RESUME_HASH);
}

#[test]
fn terms_message_matches_sdk() {
    // What a wallet signs to agree to the terms: the SDK's `termsTypedData`,
    // hashed as starknet.js does for the account that signs it.
    let t = terms();
    let account = *t.players.at(0);
    assert_eq!(
        terms_message::<CounterRules>(t.chain_id, t.game_id, CONTEXT, account), TERMS_MESSAGE,
    );
    // Another account, game or context signs another message.
    let other = terms_message::<CounterRules>(t.chain_id, t.game_id, CONTEXT, *t.players.at(1));
    assert!(other != TERMS_MESSAGE);
    assert!(
        terms_message::<CounterRules>(t.chain_id, t.game_id + 1, CONTEXT, account) != TERMS_MESSAGE,
    );
}
