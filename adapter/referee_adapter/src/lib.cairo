//! Generic logic for a referee proof adapter: an immutable account contract
//! that proves a replay natively (SNIP-36) and relays the verified result to
//! the game's channel. Ported from Surround's `ChannelProver`.
//!
//! Proving: the adapter's `__execute__` runs as a zero-fee *virtual* INVOKE_V3
//! that is never broadcast. It reads the channel snapshot, replays the signed
//! steps from the anchor with the game's rules, and emits one L2→L1 message
//! committing to the transition. A prover proves that execution.
//!
//! Settling: a real transaction calls the adapter's `settle` with the proof
//! attached. The network verifies the proof; `settle` checks the proof facts
//! commit to exactly this transition and calls the channel's `accept_verified`.
//!
//! The channel is called through raw syscalls, so any game system that exposes
//! referee_dojo's `snapshot` and `accept_verified` entrypoints works.
pub mod facts;
pub mod prover;

pub use facts::{MAX_PROOF_AGE, ProofFacts, check_facts};
pub use prover::{assert_virtual, execute, message_hash, payload, settle, snapshot};
