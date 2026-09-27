/// `last_seat` before any step has been applied.
pub const NO_SEAT: u8 = 255;
/// The actor of a `Flag`: the referee, which is not a seat.
pub const REFEREE: u8 = 254;
/// `Outcome.winner` for a drawn game. Otherwise `winner` is the winning seat + 1.
pub const DRAW: u8 = 0;
/// Finish reasons 1..=127 are game-defined; the protocol reserves the rest.
pub const REASON_RESIGN: u8 = 128;
pub const REASON_TIMEOUT: u8 = 129;

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Signature {
    pub r: felt252,
    pub s: felt252,
}

/// A timed game's time control, bound into its terms. The referee stamps every
/// step with its own clock, in milliseconds. A turn is a run of steps while the
/// game's `due` seat stays the same: that seat spends `turn_ms` first, which
/// does not carry over, then its bank, which gains `increment_ms` when the turn
/// ends. A pending reveal is timed on its own, with a fresh `turn_ms`.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct TimeControl {
    /// Public key that signs stamps and flags.
    pub referee: felt252,
    pub turn_ms: u64,
    pub bank_ms: u64,
    pub increment_ms: u64,
}

/// A timed game's clocks.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Clock {
    /// Bank left per seat.
    pub banks: Span<u64>,
    /// Allowance left in the current turn.
    pub turn: u64,
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
/// `Flag` belongs to the referee of a timed game.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub enum Move<A> {
    /// The due seat's game action.
    Play: A,
    /// The due seat's game action that requests randomness, with the actor's
    /// next hash-chain value.
    PlayRandom: (A, felt252),
    /// The pending seat's next hash-chain value.
    Reveal: felt252,
    /// The due seat replaces its hash-chain tip before the chain runs out.
    Recommit: felt252,
    /// This seat concedes, at any time.
    Resign: u8,
    /// The due seat's time ran out.
    Flag,
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

/// A randomness request waiting for `seat` to reveal.
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
    /// Number of signer changes. Ranks dispute candidates: consecutive steps by
    /// one seat never outrank a branch the other seat acknowledged.
    pub support_turn: u32,
    pub last_seat: u8,
    pub pending: Pending,
    /// Last revealed hash-chain value per seat (the committed tip initially).
    pub rng_heads: Span<felt252>,
    /// `None` for an untimed game.
    pub clock: Option<Clock>,
    pub outcome: Outcome,
    pub game: S,
}
