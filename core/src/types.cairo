/// `last_seat` before any step has been applied.
pub const NO_SEAT: u8 = 255;
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

/// Everything bound into a channel's context hash. `players` are wallet
/// addresses, `keys` are per-game session public keys and `rng_tips` are the
/// committed hash-chain tips, all indexed by seat.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Terms<C> {
    pub chain_id: felt252,
    pub channel: felt252,
    pub game_id: felt252,
    pub prover: felt252,
    pub response_seconds: u32,
    pub players: Span<felt252>,
    pub keys: Span<felt252>,
    pub rng_tips: Span<felt252>,
    pub config: C,
}

/// A step: one seat's signed move. Only `Resign` names its seat; every other
/// move belongs to the seat the state says is due (the turn's seat, or the
/// pending seat for `Reveal`), so the seat is never carried or signed twice.
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
    pub outcome: Outcome,
    pub game: S,
}
