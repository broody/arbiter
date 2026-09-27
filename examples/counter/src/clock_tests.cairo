//! Referee clocks: the timed fixture game replays against its stamps and the
//! referee's attestation, and unsigned timed steps pin the clock rules.
use referee::{
    Batch, Clock, Envelope, MAX_CLOCK_MS, Move, REASON_TIMEOUT, Signature, Terms, TimeControl,
    apply_steps, check_time_control, context_hash, force, open, replay, rng_next, state_hash,
};
use crate::fixtures::{
    CONTEXT, RNG_LEN, SEED_0, SEED_1, TIMED_CONTEXT, TIMED_STATE_HASH, finals, steps, terms,
    timed_attestations, timed_expected, timed_finals, timed_stamps, timed_steps, timed_terms,
};
use crate::{ADD, Action, Config, Counter, CounterRules, GAMBLE};

fn zero() -> Signature {
    Signature { r: 0, s: 0 }
}

fn add(amount: u8) -> Move<Action> {
    Move::Play(Action { kind: ADD, amount })
}

fn chain(seed: felt252, index: u32) -> felt252 {
    let mut value = seed;
    let mut i = 0;
    while i < index {
        value = rng_next(value);
        i += 1;
    }
    value
}

fn gamble() -> Move<Action> {
    Move::PlayRandom((Action { kind: GAMBLE, amount: 0 }, chain(SEED_1, RNG_LEN - 1)))
}

fn reveal() -> Move<Action> {
    Move::Reveal(chain(SEED_0, RNG_LEN - 1))
}

/// The fixture's timed terms (30 s turn, 60 s bank, 2 s increment) under another time control.
fn terms_with(time: TimeControl) -> Terms<Config> {
    Terms { clock: Option::Some(time), ..timed_terms() }
}

fn timed_start() -> Envelope<Counter> {
    open::<CounterRules>(@timed_terms())
}

fn run_with(
    terms: Terms<Config>, steps: Array<Move<Action>>, stamps: Array<u64>,
) -> Envelope<Counter> {
    let start = open::<CounterRules>(@terms);
    apply_steps::<CounterRules>(TIMED_CONTEXT, @terms, start, (), steps.span(), stamps.span())
}

fn run(steps: Array<Move<Action>>, stamps: Array<u64>) -> Envelope<Counter> {
    run_with(timed_terms(), steps, stamps)
}

fn clock(env: @Envelope<Counter>) -> Clock {
    (*env.clock).unwrap()
}

/// Timed fixture steps `from..to` with their stamps, final signatures and the
/// referee's attestation after step `to - 1`.
fn timed_batch(from: u32, to: u32) -> Batch<Action> {
    Batch {
        steps: timed_steps().span().slice(from, to - from),
        stamps: timed_stamps().span().slice(from, to - from),
        signatures: timed_finals(from, to).span(),
        attestation: *timed_attestations().at(to - 1),
    }
}

fn replay_timed(start: Envelope<Counter>, batch: Batch<Action>) -> Envelope<Counter> {
    replay::<CounterRules>(TIMED_CONTEXT, @timed_terms(), start, (), batch)
}

#[test]
fn timed_context_matches_sdk() {
    assert_eq!(context_hash::<CounterRules>(@timed_terms()), TIMED_CONTEXT);
}

#[test]
fn timed_replay_matches_sdk() {
    let end = replay_timed(timed_start(), timed_batch(0, 6));
    assert_eq!(end, timed_expected());
    assert_eq!(state_hash::<CounterRules>(@end), TIMED_STATE_HASH);
    assert_eq!(end.outcome.winner, 2); // seat 1: seat 0 was flagged
    assert_eq!(end.outcome.reason, REASON_TIMEOUT);
}

#[test]
fn timed_replay_splits_at_any_point() {
    let mid = replay_timed(timed_start(), timed_batch(0, 3));
    assert_eq!(replay_timed(mid, timed_batch(3, 6)), timed_expected());
}

#[test]
#[should_panic(expected: 'Invalid session signature')]
fn intermediate_attestation_is_not_a_final_one() {
    replay_timed(
        timed_start(), Batch { attestation: *timed_attestations().at(4), ..timed_batch(0, 6) },
    );
}

#[test]
#[should_panic(expected: 'Invalid session signature')]
fn tampered_stamp_breaks_the_attestation() {
    // Seat 1's gamble 5 s earlier is still a legal step, but leaves seat 1
    // more bank than the referee attested. (A stamp that only moves time within
    // a turn's allowance changes nothing the game keeps, so it needs no check.)
    let mut stamps = array![];
    for stamp in timed_stamps() {
        stamps.append(if stamp == 1040000 {
            1035000
        } else {
            stamp
        });
    }
    replay_timed(timed_start(), Batch { stamps: stamps.span(), ..timed_batch(0, 6) });
}

#[test]
#[should_panic(expected: 'Wrong stamp count')]
fn timed_replay_needs_every_stamp() {
    let batch = timed_batch(0, 6);
    replay_timed(timed_start(), Batch { stamps: batch.stamps.slice(0, 5), ..batch });
}

#[test]
#[should_panic(expected: 'Invalid signature r')]
fn timed_replay_needs_the_attestation() {
    replay_timed(timed_start(), Batch { attestation: zero(), ..timed_batch(0, 6) });
}

#[test]
#[should_panic(expected: 'Unexpected stamps')]
fn untimed_replay_takes_no_stamps() {
    let t = terms();
    let batch = Batch {
        steps: steps().span().slice(0, 1),
        stamps: array![1000].span(),
        signatures: finals(0, 1).span(),
        attestation: zero(),
    };
    replay::<CounterRules>(CONTEXT, @t, open::<CounterRules>(@t), (), batch);
}

#[test]
#[should_panic(expected: 'Unexpected attestation')]
fn untimed_replay_takes_no_attestation() {
    let t = terms();
    let batch = Batch {
        steps: steps().span().slice(0, 1),
        stamps: array![].span(),
        signatures: finals(0, 1).span(),
        attestation: *timed_attestations().at(0),
    };
    replay::<CounterRules>(CONTEXT, @t, open::<CounterRules>(@t), (), batch);
}

#[test]
fn clocks_open_paused_with_full_banks() {
    assert_eq!(
        clock(@timed_start()), Clock { banks: array![60000, 60000].span(), turn: 30000, stamp: 0 },
    );
    assert!(open::<CounterRules>(@terms()).clock.is_none());
}

#[test]
fn first_stamp_starts_the_clock_without_charge() {
    let env = run(array![add(3)], array![5000]);
    // Seat 0's turn ended: its bank gains the increment.
    assert_eq!(clock(@env), Clock { banks: array![62000, 60000].span(), turn: 30000, stamp: 5000 });
}

#[test]
fn time_comes_from_the_turn_then_the_bank() {
    let env = run(array![add(3), add(3)], array![1000, 46000]);
    // Seat 1 spent its 30 s allowance and 15 s of bank, then gained 2 s.
    assert_eq!(
        clock(@env), Clock { banks: array![62000, 47000].span(), turn: 30000, stamp: 46000 },
    );
}

#[test]
fn a_step_on_the_last_millisecond_counts() {
    let env = run(array![add(3), add(3)], array![1000, 91000]);
    assert_eq!(*clock(@env).banks.at(1), 2000);
}

#[test]
#[should_panic(expected: 'Flag fell')]
fn a_late_step_is_refused() {
    run(array![add(3), add(3)], array![1000, 91001]);
}

#[test]
fn flag_once_time_runs_out() {
    let env = run(array![add(3), Move::Flag], array![1000, 91001]);
    assert!(env.outcome.finished);
    assert_eq!(env.outcome.winner, 1); // seat 0 + 1
    assert_eq!(env.outcome.reason, REASON_TIMEOUT);
    assert_eq!(*clock(@env).banks.at(1), 0);
}

#[test]
#[should_panic(expected: 'Clock not expired')]
fn an_early_flag_is_refused() {
    run(array![add(3), Move::Flag], array![1000, 91000]);
}

#[test]
#[should_panic(expected: 'Clock not running')]
fn a_flag_needs_a_running_clock() {
    run(array![Move::Flag], array![1000]);
}

#[test]
#[should_panic(expected: 'Stamp out of order')]
fn stamps_move_forward() {
    run(array![add(3), add(3)], array![2000, 1000]);
}

#[test]
#[should_panic(expected: 'Invalid stamp')]
fn zero_is_not_a_stamp() {
    run(array![add(3)], array![0]);
}

#[test]
fn an_unstamped_step_pauses_the_clock() {
    let t = timed_terms();
    let forced = force::<
        CounterRules,
    >(TIMED_CONTEXT, @t, timed_start(), (), 0, array![add(3)].span());
    assert_eq!(clock(@forced).stamp, 0);
    // However late the next stamp, the paused clock charges nothing.
    let env = apply_steps::<
        CounterRules,
    >(TIMED_CONTEXT, @t, forced, (), array![add(3)].span(), array![999999999].span());
    assert_eq!(*clock(@env).banks.at(1), 62000);
}

#[test]
#[should_panic(expected: 'Flag needs a stamp')]
fn forced_play_cannot_flag() {
    force::<
        CounterRules,
    >(TIMED_CONTEXT, @timed_terms(), timed_start(), (), 0, array![Move::Flag].span());
}

fn per_turn() -> Terms<Config> {
    terms_with(TimeControl { referee: 1, turn_ms: 10000, bank_ms: 0, increment_ms: 0 })
}

#[test]
fn a_reveal_has_its_own_allowance() {
    // Seat 1 gambles with 1 s of its turn left; seat 0 still has a full 10 s
    // to reveal, and the roll passes the turn back with a fresh allowance.
    let env = run_with(per_turn(), array![add(3), gamble(), reveal()], array![1000, 10000, 20000]);
    assert_eq!(clock(@env), Clock { banks: array![0, 0].span(), turn: 10000, stamp: 20000 });
}

#[test]
#[should_panic(expected: 'Flag fell')]
fn a_late_reveal_is_refused() {
    run_with(per_turn(), array![add(3), gamble(), reveal()], array![1000, 10000, 20001]);
}

#[test]
fn a_withheld_reveal_is_flagged() {
    let env = run_with(
        per_turn(), array![add(3), gamble(), Move::Flag], array![1000, 10000, 20001],
    );
    assert_eq!(env.outcome.winner, 2); // seat 0 owed the reveal
    assert!(!env.pending.active);
}

#[test]
#[should_panic(expected: 'Untimed game')]
fn untimed_games_have_no_flag() {
    let t = terms();
    apply_steps::<
        CounterRules,
    >(CONTEXT, @t, open::<CounterRules>(@t), (), array![Move::Flag].span(), array![].span());
}

#[test]
#[should_panic(expected: 'Invalid time control')]
fn a_clock_needs_some_time() {
    check_time_control(
        @Option::Some(TimeControl { referee: 1, turn_ms: 0, bank_ms: 0, increment_ms: 1000 }),
    );
}

#[test]
#[should_panic(expected: 'Invalid time control')]
fn clock_settings_are_bounded() {
    check_time_control(
        @Option::Some(
            TimeControl { referee: 1, turn_ms: 0, bank_ms: MAX_CLOCK_MS + 1, increment_ms: 0 },
        ),
    );
}

#[test]
#[should_panic(expected: 'Invalid referee')]
fn a_clock_needs_a_referee() {
    check_time_control(
        @Option::Some(TimeControl { referee: 0, turn_ms: 1000, bank_ms: 0, increment_ms: 0 }),
    );
}
