/// `last_seat` before any step has been applied.
pub const NO_SEAT: u8 = 255;
/// The actor of a `Flag`, a `Start` and a roll: the referee, which is not a
/// seat.
pub const REFEREE: u8 = 254;
/// `Outcome.winner` for a drawn game. Otherwise `winner` is the winning seat + 1.
pub const DRAW: u8 = 0;
/// Finish reasons 1..=127 are game-defined; the protocol reserves the rest.
pub const REASON_RESIGN: u8 = 128;
/// The referee flagged the due seat of a timed game (`Move::Flag`).
pub const REASON_TIMEOUT: u8 = 129;
/// The chain judged that the due seat missed its forced-play window
/// (`channel::claim_timeout`), without any referee.
pub const REASON_ABANDON: u8 = 130;
/// A roll waited too long for a referee that was down, or every seat agreed to
/// stop waiting (`channel::void`). No result: not a draw, whatever `winner`
/// says.
pub const REASON_VOID: u8 = 131;

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Signature {
    pub r: felt252,
    pub s: felt252,
}

/// A timed game's time control, bound into its terms: the referee's public key,
/// which signs stamps and flags, the settings of the game's `ClockRules`,
/// serialized, and the tip of the referee's own hash chain when the game takes
/// its randomness from the referee (zero when the seats reveal to each other).
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct TimeControl {
    pub referee: felt252,
    pub settings: Span<felt252>,
    pub rng_tip: felt252,
}

/// A timed game's clock. The time a turn uses adds up in `used` and is settled
/// by the game's `ClockRules` when the turn ends.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Clock {
    /// Each seat's clocks, as the game's `ClockRules` serialize them.
    pub seats: Span<felt252>,
    /// Time used so far in the current turn, in milliseconds.
    pub used: u64,
    /// Referee time of the last stamped step, or 0 while the clock is paused:
    /// before the first stamp, and after an unstamped (forced onchain) step.
    pub stamp: u64,
}

/// Everything bound into a channel's context hash. `players` are wallet
/// addresses, `keys` are per-game session public keys and `rng_tips` are the
/// committed hash-chain tips, all indexed by seat. `clock` is `None` for an
/// untimed game.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Terms<C> {
    pub chain_id: felt252,
    pub channel: felt252,
    pub game_id: felt252,
    pub prover: felt252,
    pub response_seconds: u32,
    pub clock: Option<TimeControl>,
    pub players: Span<felt252>,
    pub keys: Span<felt252>,
    pub rng_tips: Span<felt252>,
    pub config: C,
}

/// A step: one seat's signed move. Only `Resign` names its seat; every other
/// move belongs to the seat the state says is due (the turn's seat, or the
/// pending seat for `Reveal`), so the seat is never carried or signed twice.
/// `Flag` and `Start` belong to the referee of a timed game, and so does a
/// `Reveal` when the game takes its randomness from the referee.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub enum Move<A> {
    /// The due seat's game action.
    Play: A,
    /// The due seat's game action that requests randomness, with the actor's
    /// next hash-chain value.
    PlayRandom: (A, felt252),
    /// The pending seat's next hash-chain value, or the referee's.
    Reveal: felt252,
    /// The due seat replaces its hash-chain tip before the chain runs out. Only
    /// after it revealed from its current one (`Envelope.rng_fresh`).
    Recommit: felt252,
    /// This seat concedes, at any time.
    Resign: u8,
    /// The due seat's time ran out.
    Flag,
    /// The referee starts or restarts the clock without charging anyone: before
    /// the first move, and after play resumes from forced play.
    Start,
}

/// Steps to replay, with what authenticates them: one final signature per seat
/// (zero for a seat with no step) and, in a timed game, each step's stamp and
/// the referee's attestation of the end state (zero when there are no steps).
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Batch<A> {
    pub steps: Span<Move<A>>,
    /// One per step in a timed game; empty otherwise.
    pub stamps: Span<u64>,
    pub signatures: Span<Signature>,
    pub attestation: Signature,
}

/// A randomness request waiting for `seat` to reveal: a seat, or `REFEREE`.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Pending {
    pub active: bool,
    pub seat: u8,
    /// Sequence number of the step that made the request.
    pub seq: u32,
    /// The requesting seat's revealed value.
    pub entropy: felt252,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Outcome {
    pub finished: bool,
    pub winner: u8,
    pub reason: u8,
}

/// Protocol bookkeeping around a game's state.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Envelope<S> {
    pub seq: u32,
    pub transcript: felt252,
    /// Number of changes of signing seat. Ranks dispute candidates: consecutive
    /// steps by one seat never outrank a branch the other seat acknowledged.
    /// The referee's steps count for neither seat.
    pub support_turn: u32,
    /// The last seat that signed a step.
    pub last_seat: u8,
    pub pending: Pending,
    /// Last revealed hash-chain value per seat (the committed tip initially).
    pub rng_heads: Span<felt252>,
    /// Per seat: whether its head is a tip it committed and has not revealed
    /// from yet. A seat may recommit only after a reveal.
    pub rng_fresh: Span<bool>,
    /// The referee's last revealed hash-chain value (its committed tip
    /// initially), or zero when the seats reveal to each other.
    pub rng_referee: felt252,
    /// `None` for an untimed game.
    pub clock: Option<Clock>,
    pub outcome: Outcome,
    pub game: S,
}
