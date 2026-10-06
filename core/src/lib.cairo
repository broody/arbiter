//! Game-agnostic protocol for offchain turn-based play with onchain settlement.
//!
//! A game implements `GameRules`. This crate wraps the game state in an
//! `Envelope` that carries the protocol bookkeeping (sequence, transcript,
//! signer changes, hash-chain randomness, referee clocks, outcome) and replays
//! signed steps.
//! It has no Dojo or Starknet storage dependency so the same source builds for
//! the Dojo channel (Cairo 2.13) and the native proof adapter (Cairo 2.18).

pub mod channel;
pub mod clocks;
pub mod protocol;
pub mod rules;
pub mod types;
pub use channel::{Channel, StateRef, state_ref};

pub use protocol::{
    PROTOCOL_VERSION, action_hash, actor, apply_steps, approve_all, check_clock, checkpoint_hash,
    context_hash, delegation_message, due, force, forfeit, game_id_of, live_hash, open,
    referee_resume_hash, reopen_hash, replay, rng_next, roll, seed, signing_hash, stamp_hash,
    state_hash, terms_message, tip_hash, verify, void_hash,
};
pub use rules::GameRules;
pub use types::{
    Approval, Batch, Clock, DRAW, Delegated, Envelope, Move, NO_SEAT, Outcome, Pending,
    REASON_ABANDON, REASON_RESIGN, REASON_TIMEOUT, REASON_VOID, REFEREE, Signature, Terms,
    TimeControl,
};
