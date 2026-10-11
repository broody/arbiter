//! Dojo binding for arbiter channels. A game registers these models in its
//! namespace via `build-external-contracts` and implements its system with the
//! helpers in `channel`, and in `rated` for games rated on an `arbiter_ratings`
//! contract.
pub mod channel;
pub mod models;
pub mod rated;
