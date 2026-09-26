//! Game-agnostic protocol for offchain turn-based play with onchain settlement.
//!
//! A game implements `GameRules`. This crate wraps the game state in an
//! `Envelope` that carries the protocol bookkeeping (sequence, transcript,
//! signer changes, hash-chain randomness, outcome) and replays signed steps.
//! It has no Dojo or Starknet storage dependency so the same source builds for
//! the Dojo channel (Cairo 2.13) and the native proof adapter (Cairo 2.18).

pub mod channel;
pub mod protocol;
pub mod rules;
pub mod types;
pub use channel::{Channel, StateRef, state_ref};

pub use protocol::{
    PROTOCOL_VERSION, action_hash, actor, apply_steps, approve_all, checkpoint_hash, context_hash,
    due, force, open, reopen_hash, replay, rng_next, seed, signing_hash, state_hash, verify,
};
pub use rules::GameRules;
pub use types::{
    DRAW, Envelope, Move, NO_SEAT, Outcome, Pending, REASON_RESIGN, REASON_TIMEOUT, Signature,
    Terms,
};
