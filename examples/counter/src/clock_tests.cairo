//! Referee clocks: the timed fixture games replay against their stamps and the
//! referee's attestation, and unsigned timed steps pin the clock rules, on the
//! standard time rules and on the hourglass example.
use referee::clocks::{
    Byoyomi, MAX_CLOCK_MS, MAX_PERIODS, Standard, StandardClock, StandardTime, decode, encode,
};
use referee::{
    Batch, Clock, Envelope, Move, REASON_TIMEOUT, Signature, Terms, TimeControl, apply_steps,
    check_clock, context_hash, force, open, replay, rng_next, state_hash,
};
use crate::fixtures::{
    BYOYOMI_CONTEXT, BYOYOMI_STATE_HASH, CONTEXT, HOURGLASS_CONTEXT, HOURGLASS_STATE_HASH, RNG_LEN,
    SEED_0, SEED_1, TIMED_CONTEXT, TIMED_STATE_HASH, byoyomi_attestations, byoyomi_expected,
    byoyomi_finals, byoyomi_stamps, byoyomi_steps, byoyomi_terms, finals, hourglass_attestations,
    hourglass_expected, hourglass_finals, hourglass_stamps, hourglass_steps, hourglass_terms, steps,
    terms, timed_attestations, timed_expected, timed_finals, timed_stamps, timed_steps, timed_terms,
};
use crate::hourglass::{Hourglass, HourglassClock, HourglassCounterRules};
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

/// The fixture's timed terms under other standard settings.
fn standard(settings: Standard) -> Terms<Config> {
    Terms {
        clock: Option::Some(TimeControl { referee: 1, settings: encode(@settings) }),
        ..timed_terms(),
    }
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

/// The standard time rules' clocks: each seat's bank and periods.
fn seats(env: @Envelope<Counter>) -> StandardClock {
    decode(clock(env).seats)
}

fn banks(env: @Envelope<Counter>) -> Span<u64> {
    seats(env).banks
}

fn periods(env: @Envelope<Counter>) -> Span<u32> {
    seats(env).periods
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
    let env = timed_start();
    assert_eq!(banks(@env), array![60000, 60000].span());
    assert_eq!(periods(@env), array![].span());
    assert_eq!((clock(@env).used, clock(@env).stamp), (0, 0));
    assert!(open::<CounterRules>(@terms()).clock.is_none());
}

#[test]
fn first_stamp_starts_the_clock_without_charge() {
    let env = run(array![add(3)], array![5000]);
    // Seat 0's turn ended: its bank gains the increment.
    assert_eq!(banks(@env), array![62000, 60000].span());
    assert_eq!((clock(@env).used, clock(@env).stamp), (0, 5000));
}

#[test]
fn time_comes_from_the_turn_then_the_bank() {
    let env = run(array![add(3), add(3)], array![1000, 46000]);
    // Seat 1 spent its 30 s allowance and 15 s of bank, then gained 2 s.
    assert_eq!(banks(@env), array![62000, 47000].span());
}

#[test]
fn a_turn_adds_up_its_steps() {
    // Seat 0 recommits and then plays: 40 s in one turn, 10 s from its bank.
    let env = run(
        array![add(3), add(3), Move::Recommit(rng_next(0x5eed2))], array![1000, 2000, 22000],
    );
    assert_eq!(clock(@env).used, 20000);
    let env = apply_steps::<
        CounterRules,
    >(TIMED_CONTEXT, @timed_terms(), env, (), array![add(3)].span(), array![42000].span());
    assert_eq!(banks(@env), array![54000, 62000].span());
    assert_eq!(clock(@env).used, 0);
}

#[test]
fn a_step_on_the_last_millisecond_counts() {
    let env = run(array![add(3), add(3)], array![1000, 91000]);
    assert_eq!(*banks(@env).at(1), 2000);
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
    assert_eq!(*banks(@env).at(1), 62000);
}

#[test]
#[should_panic(expected: 'Flag needs a stamp')]
fn forced_play_cannot_flag() {
    force::<
        CounterRules,
    >(TIMED_CONTEXT, @timed_terms(), timed_start(), (), 0, array![Move::Flag].span());
}

fn per_turn() -> Terms<Config> {
    standard(Standard { turn_ms: 10000, bank_ms: 0, increment_ms: 0, byoyomi: Option::None })
}

#[test]
fn a_reveal_has_its_own_allowance() {
    // Seat 1 gambles with 1 s of its turn left; seat 0 still has a full 10 s
    // to reveal, and the roll passes the turn back with a fresh allowance.
    let env = run_with(per_turn(), array![add(3), gamble(), reveal()], array![1000, 10000, 20000]);
    assert_eq!(banks(@env), array![0, 0].span());
    assert_eq!((clock(@env).used, clock(@env).stamp), (0, 20000));
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

fn check_standard(settings: Standard) {
    StandardTime::<Counter>::check(encode(@settings));
}

#[test]
#[should_panic(expected: 'Invalid time control')]
fn a_clock_needs_some_time() {
    check_standard(Standard { turn_ms: 0, bank_ms: 0, increment_ms: 1000, byoyomi: Option::None });
}

#[test]
#[should_panic(expected: 'Invalid time control')]
fn clock_settings_are_bounded() {
    check_standard(
        Standard { turn_ms: 0, bank_ms: MAX_CLOCK_MS + 1, increment_ms: 0, byoyomi: Option::None },
    );
}

#[test]
#[should_panic(expected: 'Invalid referee')]
fn a_clock_needs_a_referee() {
    let settings = Standard { turn_ms: 1000, bank_ms: 0, increment_ms: 0, byoyomi: Option::None };
    check_clock::<
        CounterRules,
    >(@Option::Some(TimeControl { referee: 0, settings: encode(@settings) }));
}

#[test]
#[should_panic(expected: 'Invalid clock data')]
fn clock_settings_must_decode_exactly() {
    let mut settings = array![1000, 0, 0, 1, 7];
    check_clock::<
        CounterRules,
    >(@Option::Some(TimeControl { referee: 1, settings: settings.span() }));
}

fn byoyomi_start() -> Envelope<Counter> {
    open::<CounterRules>(@byoyomi_terms())
}

fn byoyomi_batch(from: u32, to: u32) -> Batch<Action> {
    Batch {
        steps: byoyomi_steps().span().slice(from, to - from),
        stamps: byoyomi_stamps().span().slice(from, to - from),
        signatures: byoyomi_finals(from, to).span(),
        attestation: *byoyomi_attestations().at(to - 1),
    }
}

/// 10 s of main time, then 3 periods of 5 s, as in the byo-yomi fixture.
fn japanese() -> Terms<Config> {
    standard(
        Standard {
            turn_ms: 0,
            bank_ms: 10000,
            increment_ms: 0,
            byoyomi: Option::Some(Byoyomi { periods: 3, period_ms: 5000 }),
        },
    )
}

#[test]
fn byoyomi_replay_matches_sdk() {
    assert_eq!(context_hash::<CounterRules>(@byoyomi_terms()), BYOYOMI_CONTEXT);
    let end = replay::<
        CounterRules,
    >(BYOYOMI_CONTEXT, @byoyomi_terms(), byoyomi_start(), (), byoyomi_batch(0, 7));
    assert_eq!(end, byoyomi_expected());
    assert_eq!(state_hash::<CounterRules>(@end), BYOYOMI_STATE_HASH);
    assert_eq!(end.outcome.winner, 1); // seat 0: seat 1 ran out of periods
    assert_eq!(end.outcome.reason, REASON_TIMEOUT);
}

#[test]
fn byoyomi_clocks_open_with_every_period() {
    let env = open::<CounterRules>(@japanese());
    assert_eq!(periods(@env), array![3, 3].span());
    assert_eq!(banks(@env), array![10000, 10000].span());
}

#[test]
fn main_time_comes_before_the_periods() {
    let env = run_with(japanese(), array![add(3), add(3)], array![1000, 11000]);
    assert_eq!(banks(@env), array![10000, 0].span());
    assert_eq!(periods(@env), array![3, 3].span());
}

#[test]
fn a_turn_ending_inside_a_period_costs_none() {
    // Seat 1: its 10 s of main time, then exactly one 5 s period.
    let env = run_with(japanese(), array![add(3), add(3)], array![1000, 16000]);
    assert_eq!(periods(@env), array![3, 3].span());
}

#[test]
fn each_period_that_runs_out_is_lost() {
    // One millisecond into the second period, then 1 ms into the third.
    let env = run_with(japanese(), array![add(3), add(3)], array![1000, 16001]);
    assert_eq!(periods(@env), array![3, 2].span());
    let env = run_with(japanese(), array![add(3), add(3)], array![1000, 21001]);
    assert_eq!(periods(@env), array![3, 1].span());
}

#[test]
fn the_last_period_can_be_used_to_its_end() {
    let env = run_with(japanese(), array![add(3), add(3)], array![1000, 26000]);
    assert_eq!(periods(@env), array![3, 1].span());
}

#[test]
#[should_panic(expected: 'Flag fell')]
fn outlasting_the_last_period_flags() {
    run_with(japanese(), array![add(3), add(3)], array![1000, 26001]);
}

#[test]
fn a_flag_in_overtime_ends_the_game() {
    let env = run_with(japanese(), array![add(3), Move::Flag], array![1000, 26001]);
    assert_eq!(env.outcome.winner, 1);
    assert_eq!(env.outcome.reason, REASON_TIMEOUT);
}

#[test]
fn periods_count_per_turn_not_per_step() {
    // Seat 0 recommits and then plays: one turn, 7 s of overtime in all.
    let env = run_with(
        japanese(),
        array![add(3), add(3), Move::Recommit(rng_next(0x5eed2)), add(3)],
        array![1000, 2000, 15000, 19000],
    );
    assert_eq!(banks(@env), array![0, 9000].span());
    assert_eq!(periods(@env), array![2, 3].span());
}

#[test]
#[should_panic(expected: 'Invalid byo-yomi')]
fn byoyomi_needs_a_period() {
    check_standard(
        Standard {
            turn_ms: 0,
            bank_ms: 1000,
            increment_ms: 0,
            byoyomi: Option::Some(Byoyomi { periods: 0, period_ms: 1000 }),
        },
    );
}

#[test]
#[should_panic(expected: 'Invalid byo-yomi')]
fn byoyomi_periods_are_bounded() {
    check_standard(
        Standard {
            turn_ms: 0,
            bank_ms: 0,
            increment_ms: 0,
            byoyomi: Option::Some(Byoyomi { periods: MAX_PERIODS + 1, period_ms: 1000 }),
        },
    );
}

#[test]
fn byoyomi_alone_is_a_time_control() {
    check_standard(
        Standard {
            turn_ms: 0,
            bank_ms: 0,
            increment_ms: 0,
            byoyomi: Option::Some(Byoyomi { periods: 1, period_ms: 30000 }),
        },
    );
}

fn hourglass_start() -> Envelope<Counter> {
    open::<HourglassCounterRules>(@hourglass_terms())
}

fn hourglass_banks(env: @Envelope<Counter>) -> Span<u64> {
    let clock: HourglassClock = decode(clock(env).seats);
    clock.banks
}

#[test]
fn hourglass_replay_matches_sdk() {
    assert_eq!(context_hash::<HourglassCounterRules>(@hourglass_terms()), HOURGLASS_CONTEXT);
    let batch = Batch {
        steps: hourglass_steps().span(),
        stamps: hourglass_stamps().span(),
        signatures: hourglass_finals(0, 5).span(),
        attestation: *hourglass_attestations().at(4),
    };
    let end = replay::<
        HourglassCounterRules,
    >(HOURGLASS_CONTEXT, @hourglass_terms(), hourglass_start(), (), batch);
    assert_eq!(end, hourglass_expected());
    assert_eq!(state_hash::<HourglassCounterRules>(@end), HOURGLASS_STATE_HASH);
    assert_eq!(end.outcome.winner, 2); // seat 1: seat 0 ran dry
}

#[test]
fn hourglass_time_flows_to_the_opponent() {
    let t = hourglass_terms();
    let env = apply_steps::<
        HourglassCounterRules,
    >(
        HOURGLASS_CONTEXT,
        @t,
        hourglass_start(),
        (),
        array![add(3), add(3)].span(),
        array![1000, 5000].span(),
    );
    assert_eq!(hourglass_banks(@env), array![14000, 6000].span());
}

#[test]
#[should_panic(expected: 'Invalid hourglass')]
fn hourglass_checks_its_settings() {
    let t = Terms {
        clock: Option::Some(
            TimeControl { referee: 1, settings: encode(@Hourglass { bank_ms: 0 }) },
        ),
        ..hourglass_terms(),
    };
    open::<HourglassCounterRules>(@t);
}
