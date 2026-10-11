use arbiter::signing_hash;
use starknet::ContractAddress;
use crate::rules::RatingRules;

/// A rated pairing signed by a game's matchmaker: who plays whom, in which
/// pool, on which channel, under which terms. Both wallets sign the game's
/// terms, whose config carries the ticket's digest (`arbiter::RatedConfig`);
/// the channel opens the game with it (`open_rated_game`) when the game first
/// needs the chain, and the ratings contract accepts each ticket once. The
/// game must start within the ticket's window.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Ticket {
    pub chain_id: felt252,
    /// The channel contract the game is played on.
    pub channel: ContractAddress,
    /// The seats, in the terms' order.
    pub player_0: ContractAddress,
    pub player_1: ContractAddress,
    /// The pool the game is rated in, a short string such as 'blitz'.
    pub pool: felt252,
    /// The game's config without its ticket (`arbiter::config_hash`).
    pub config: felt252,
    /// Rated games are always timed: the referee key, and the Poseidon hash of
    /// the clock settings. A referee's randomness tip isn't known at pairing,
    /// so the ticket leaves it out.
    pub referee: felt252,
    pub clock: felt252,
    pub prover: ContractAddress,
    pub response_seconds: u32,
    /// `QUEUE` or `TABLE`.
    pub source: u8,
    /// Starting bands, used for a player's first rated game in the pool; 0
    /// for an anchor.
    pub band_0: u8,
    pub band_1: u8,
    /// The matchmaker key that signed this ticket.
    pub matchmaker: felt252,
    /// Unix seconds: when the matchmaker paired the players, and the deadline
    /// for the game's start (its referee's first stamp).
    pub issued_at: u64,
    pub expires_at: u64,
    pub nonce: felt252,
}

/// The message the matchmaker signs: arbiter's 250-bit `signing_hash` over the
/// game's tag, the ratings contract that accepts the ticket and the ticket's
/// Serde encoding, so any language reproduces it from the same fields (the
/// SDK's `ticketDigest`).
pub fn digest<impl R: RatingRules>(ticket: @Ticket, ratings: ContractAddress) -> felt252 {
    let mut fields = array!['ARBITER_PAIRING_V1', R::TAG, ratings.into()];
    ticket.serialize(ref fields);
    signing_hash(fields.span())
}
