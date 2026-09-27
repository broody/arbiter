//! Time rules: how a timed game's clocks run. The protocol stamps steps, adds
//! up the time each turn uses, pauses during forced play and times a pending
//! reveal as a one-step turn. A game's `ClockRules` decide what a seat has and
//! what a finished turn costs. `StandardTime` covers per-turn timers, delay,
//! Fischer increments and Japanese byo-yomi.

/// Upper bound on each `Standard` time setting: 30 days.
pub const MAX_CLOCK_MS: u64 = 2592000000;
/// Upper bound on byo-yomi periods.
pub const MAX_PERIODS: u32 = 255;

/// A game's time rules. `S` is the game's state, for rules that depend on it.
/// Settings and clocks cross this interface serialized: the settings as bound
/// into the terms, the clocks as carried in the envelope and attested. A rule
/// set decodes them into its own types (`decode`, `encode`).
pub trait ClockRules<S> {
    /// Panic on settings a game could not be played under.
    fn check(settings: Span<felt252>);
    /// Each seat's clocks when the game opens.
    fn open(settings: Span<felt252>, seats: u8) -> Span<felt252>;
    /// Time `seat` can use in a turn that starts with `clock`. Past it, the
    /// seat has flagged.
    fn limit(settings: Span<felt252>, clock: Span<felt252>, seat: u8, state: @S) -> u64;
    /// End a turn in which `seat` used `used`, or its answer to a reveal
    /// (`reveal`), and return the clocks the next turn starts with.
    fn settle(
        settings: Span<felt252>, clock: Span<felt252>, seat: u8, used: u64, reveal: bool, state: @S,
    ) -> Span<felt252>;
}

/// Deserialize `data`, which must hold exactly one `T`.
pub fn decode<T, +Serde<T>, +Drop<T>>(mut data: Span<felt252>) -> T {
    let value = Serde::deserialize(ref data).expect('Invalid clock data');
    assert(data.len() == 0, 'Invalid clock data');
    value
}

pub fn encode<T, +Serde<T>>(value: @T) -> Span<felt252> {
    let mut data = array![];
    value.serialize(ref data);
    data.span()
}

/// The standard time control, in milliseconds. A turn's time comes from
/// `turn_ms` first, which does not carry over, then from the seat's bank (main
/// time), then from its byo-yomi periods if the game has them. The bank gains
/// `increment_ms` when a turn ends. A reveal gets its own `turn_ms`.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Standard {
    pub turn_ms: u64,
    pub bank_ms: u64,
    pub increment_ms: u64,
    pub byoyomi: Option<Byoyomi>,
}

/// Japanese byo-yomi: once its bank is spent, a seat must end each turn within
/// a period. A turn that ends inside a period costs none; each period that runs
/// out is lost, and the seat whose last period runs out has flagged.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Byoyomi {
    pub periods: u32,
    pub period_ms: u64,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct StandardClock {
    /// Bank (main time) left per seat.
    pub banks: Span<u64>,
    /// Byo-yomi periods left per seat; empty without byo-yomi.
    pub periods: Span<u32>,
}

/// `Standard` settings and `StandardClock` clocks. `limit` and `settle` read
/// both in place rather than decoding them, since they run on every move: the
/// settings serialize as `[turn_ms, bank_ms, increment_ms, 0, periods,
/// period_ms]` with byo-yomi or `[turn_ms, bank_ms, increment_ms, 1]` without,
/// and the clocks as `[n, bank_0, .., bank_n-1, m, periods_0, .., periods_m-1]`.
pub impl StandardTime<S> of ClockRules<S> {
    fn check(settings: Span<felt252>) {
        let settings: Standard = decode(settings);
        assert(
            settings.turn_ms <= MAX_CLOCK_MS
                && settings.bank_ms <= MAX_CLOCK_MS
                && settings.increment_ms <= MAX_CLOCK_MS,
            'Invalid time control',
        );
        let overtime = match settings.byoyomi {
            Option::Some(byoyomi) => {
                assert(
                    byoyomi.periods > 0
                        && byoyomi.periods <= MAX_PERIODS
                        && byoyomi.period_ms > 0
                        && byoyomi.period_ms <= MAX_CLOCK_MS,
                    'Invalid byo-yomi',
                );
                true
            },
            Option::None => false,
        };
        assert(settings.turn_ms > 0 || settings.bank_ms > 0 || overtime, 'Invalid time control');
    }

    fn open(settings: Span<felt252>, seats: u8) -> Span<felt252> {
        let settings: Standard = decode(settings);
        let (mut banks, mut periods) = (array![], array![]);
        while banks.len() < seats.into() {
            banks.append(settings.bank_ms);
            if let Option::Some(byoyomi) = settings.byoyomi {
                periods.append(byoyomi.periods);
            }
        }
        encode(@StandardClock { banks: banks.span(), periods: periods.span() })
    }

    fn limit(settings: Span<felt252>, clock: Span<felt252>, seat: u8, state: @S) -> u64 {
        let seat: u32 = seat.into();
        let total = read(settings, 0) + read(clock, 1 + seat);
        if *settings.at(3) == 0 {
            let seats = read(clock, 0).try_into().unwrap();
            total + read(clock, 2 + seats + seat) * read(settings, 5)
        } else {
            total
        }
    }

    fn settle(
        settings: Span<felt252>, clock: Span<felt252>, seat: u8, used: u64, reveal: bool, state: @S,
    ) -> Span<felt252> {
        let seat: u32 = seat.into();
        let (turn_ms, increment_ms) = (read(settings, 0), read(settings, 2));
        let bank = read(clock, 1 + seat);
        let over = if used > turn_ms {
            used - turn_ms
        } else {
            0
        };
        let from_bank = if over < bank {
            over
        } else {
            bank
        };
        let increment = if reveal {
            0
        } else {
            increment_ms
        };
        let banked = (bank - from_bank + increment).into();
        let overtime = over - from_bank;
        let seats: u32 = read(clock, 0).try_into().unwrap();
        // Copy the clocks, with this seat's bank and, if byo-yomi periods ran
        // out, its periods replaced. The period the turn ended in is not lost.
        let mut out = array![];
        out.append_span(clock.slice(0, 1 + seat));
        out.append(banked);
        let periods_at = 2 + seats + seat;
        if overtime > 0 && *settings.at(3) == 0 {
            let lost = (overtime - 1) / read(settings, 5);
            out.append_span(clock.slice(2 + seat, periods_at - 2 - seat));
            out.append((read(clock, periods_at) - lost).into());
            out.append_span(clock.slice(periods_at + 1, clock.len() - periods_at - 1));
        } else {
            out.append_span(clock.slice(2 + seat, clock.len() - 2 - seat));
        }
        out.span()
    }
}

// One u64 field of serialized settings or clocks.
fn read(data: Span<felt252>, at: u32) -> u64 {
    (*data.at(at)).try_into().expect('Invalid clock data')
}
