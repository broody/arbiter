use crate::clocks::ClockRules;

/// What a game implements. Every function must be deterministic and panic on
/// an illegal action: the same code runs in clients, the Dojo channel and the
/// proving program.
pub trait GameRules {
    /// Game-specific terms bound into the context (board size, map hash, ...).
    type Config;
    type State;
    type Action;
    /// Extra replay input supplied as calldata (position history, map terrain).
    type Witness;
    /// Working memory built from the witness, e.g. a `Felt252Dict`.
    type Scratch;

    /// Domain tag, e.g. 'SURROUND'. Keeps hashes of different games apart.
    const TAG: felt252;
    const RULES_VERSION: u32;
    /// Number of seats. The protocol currently supports 2.
    const SEATS: u8;
    /// How the game's clocks run when it is timed, e.g.
    /// `arbiter::clocks::StandardTime<State>`. Untimed games never use it.
    impl Time: ClockRules<Self::State>;

    fn init(config: @Self::Config) -> Self::State;

    /// Check `witness` against `config` and `state`, and build scratch memory.
    fn load(config: @Self::Config, state: @Self::State, witness: Self::Witness) -> Self::Scratch;

    /// Apply `seat`'s action. Returns the new state and, if the action needs
    /// shared randomness, the seat that must reveal before play continues.
    fn apply(
        config: @Self::Config,
        ref scratch: Self::Scratch,
        state: Self::State,
        seat: u8,
        action: Self::Action,
    ) -> (Self::State, Option<u8>);

    /// Complete the pending randomness request with the agreed seed. Games
    /// that never request randomness can panic here.
    fn resolve(
        config: @Self::Config, ref scratch: Self::Scratch, state: Self::State, seed: felt252,
    ) -> Self::State;

    /// Seat due to act. The protocol overrides this while a reveal is pending.
    fn due(state: @Self::State) -> u8;

    /// `Some((winner, reason))` once the game is over; `winner` is seat + 1 or
    /// `DRAW`, and `reason` is in 1..=127. A game bounds its own length here
    /// (a move or round limit), so it always ends.
    fn outcome(state: @Self::State) -> Option<(u8, u8)>;

    /// The most steps (`seq`) a transcript may hold. The protocol ends the game
    /// with `adjudicate` at the first step at or past it that leaves no reveal
    /// pending. A safety net for transcripts, proofs and archives, not the
    /// game's own limit: set it to at least the game's longest game times
    /// (1 + protocol steps per game action).
    fn max_steps(config: @Self::Config) -> u32;

    /// `(winner, reason)` for a game stopped at `max_steps`, as `outcome`
    /// reports them.
    fn adjudicate(config: @Self::Config, state: @Self::State) -> (u8, u8);
}
