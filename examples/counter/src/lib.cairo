//! Minimal referee game. Seats alternate. ADD raises a shared counter by 1..=3;
//! GAMBLE asks the opponent for randomness and raises it by a d6 roll. Whoever
//! brings the counter to the target wins.
use referee::GameRules;

pub const ADD: u8 = 0;
pub const GAMBLE: u8 = 1;
/// Finish reason: the counter reached the target.
pub const REACHED: u8 = 1;
/// Finish reason: the transcript reached `max_steps`, a draw.
pub const LIMIT: u8 = 2;

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Config {
    pub target: u8,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Counter {
    pub total: u8,
    pub next: u8,
    /// True while a GAMBLE waits for the opponent's reveal.
    pub gamble: bool,
    /// Seat + 1 once someone reached the target.
    pub winner: u8,
    pub target: u8,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Action {
    pub kind: u8,
    pub amount: u8,
}

pub impl CounterRules of GameRules {
    type Config = Config;
    type State = Counter;
    type Action = Action;
    type Witness = ();
    type Scratch = ();

    const TAG: felt252 = 'COUNTER';
    const RULES_VERSION: u32 = 1;
    const SEATS: u8 = 2;
    impl Time = referee::clocks::StandardTime<Counter>;

    fn init(config: @Config) -> Counter {
        assert(*config.target > 0, 'Invalid target');
        Counter { total: 0, next: 0, gamble: false, winner: 0, target: *config.target }
    }

    fn load(config: @Config, state: @Counter, witness: ()) -> () {}

    fn apply(
        config: @Config, ref scratch: (), state: Counter, seat: u8, action: Action,
    ) -> (Counter, Option<u8>) {
        if action.kind == ADD {
            assert(action.amount >= 1 && action.amount <= 3, 'Invalid amount');
            (advance(state, seat, action.amount), Option::None)
        } else {
            assert(action.kind == GAMBLE && action.amount == 0, 'Invalid action');
            (Counter { gamble: true, ..state }, Option::Some(1 - seat))
        }
    }

    fn resolve(config: @Config, ref scratch: (), state: Counter, seed: felt252) -> Counter {
        assert(state.gamble, 'Nothing to resolve');
        let seed: u256 = seed.into();
        let roll: u8 = (seed.low % 6 + 1).try_into().unwrap();
        advance(Counter { gamble: false, ..state }, state.next, roll)
    }

    fn due(state: @Counter) -> u8 {
        *state.next
    }

    fn outcome(state: @Counter) -> Option<(u8, u8)> {
        if *state.winner != 0 {
            Option::Some((*state.winner, REACHED))
        } else {
            Option::None
        }
    }

    /// Every action raises the counter, so a game takes at most `target`
    /// actions; a gamble adds a reveal and allows each seat one recommit.
    fn max_steps(config: @Config) -> u32 {
        let target: u32 = (*config.target).into();
        4 * target + 16
    }

    fn adjudicate(config: @Config, state: @Counter) -> (u8, u8) {
        (referee::DRAW, LIMIT)
    }
}

fn advance(state: Counter, seat: u8, amount: u8) -> Counter {
    let total = state.total + amount;
    let winner = if total >= state.target {
        seat + 1
    } else {
        0
    };
    Counter { total, next: 1 - seat, gamble: false, winner, target: state.target }
}

#[cfg(test)]
mod channel_tests;
#[cfg(test)]
mod clock_tests;
#[cfg(test)]
mod fixtures;

pub mod hourglass;
#[cfg(test)]
mod tests;
