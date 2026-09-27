//! A game with its own time rules: the counter game on an hourglass, where the
//! time a seat uses flows to its opponent. Any `ClockRules` plugs in the same
//! way, through `GameRules::Time`.
use referee::GameRules;
use referee::clocks::{ClockRules, MAX_CLOCK_MS, decode, encode};
use crate::{Action, Config, Counter, CounterRules};

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Hourglass {
    pub bank_ms: u64,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct HourglassClock {
    pub banks: Span<u64>,
}

/// Each seat starts with `bank_ms`. A turn's time leaves the seat's bank and
/// joins its opponent's (two seats).
pub impl HourglassTime<S> of ClockRules<S> {
    fn check(settings: Span<felt252>) {
        let settings: Hourglass = decode(settings);
        assert(settings.bank_ms > 0 && settings.bank_ms <= MAX_CLOCK_MS, 'Invalid hourglass');
    }

    fn open(settings: Span<felt252>, seats: u8) -> Span<felt252> {
        let settings: Hourglass = decode(settings);
        let mut banks = array![];
        while banks.len() < seats.into() {
            banks.append(settings.bank_ms);
        }
        encode(@HourglassClock { banks: banks.span() })
    }

    fn limit(settings: Span<felt252>, clock: Span<felt252>, seat: u8, state: @S) -> u64 {
        let clock: HourglassClock = decode(clock);
        *clock.banks.at(seat.into())
    }

    fn settle(
        settings: Span<felt252>, clock: Span<felt252>, seat: u8, used: u64, reveal: bool, state: @S,
    ) -> Span<felt252> {
        let clock: HourglassClock = decode(clock);
        let (first, second) = (*clock.banks.at(0), *clock.banks.at(1));
        let banks = if seat == 0 {
            array![first - used, second + used]
        } else {
            array![first + used, second - used]
        };
        encode(@HourglassClock { banks: banks.span() })
    }
}

/// The counter game's rules with hourglass time.
pub impl HourglassCounterRules of GameRules {
    type Config = Config;
    type State = Counter;
    type Action = Action;
    type Witness = ();
    type Scratch = ();

    const TAG: felt252 = 'COUNTER';
    const RULES_VERSION: u32 = 1;
    const SEATS: u8 = 2;
    impl Time = HourglassTime<Counter>;

    fn init(config: @Config) -> Counter {
        CounterRules::init(config)
    }

    fn load(config: @Config, state: @Counter, witness: ()) -> () {}

    fn apply(
        config: @Config, ref scratch: (), state: Counter, seat: u8, action: Action,
    ) -> (Counter, Option<u8>) {
        CounterRules::apply(config, ref scratch, state, seat, action)
    }

    fn resolve(config: @Config, ref scratch: (), state: Counter, seed: felt252) -> Counter {
        CounterRules::resolve(config, ref scratch, state, seed)
    }

    fn due(state: @Counter) -> u8 {
        CounterRules::due(state)
    }

    fn outcome(state: @Counter) -> Option<(u8, u8)> {
        CounterRules::outcome(state)
    }
}
