//! Onchain ratings for arbiter games. A game implements `RatingRules` and
//! builds its ratings contract from `RatingsComponent`: a plain Starknet
//! contract that outlives Dojo worlds, whose allowlisted channels open rated
//! games on matchmaker-signed tickets and report their results. See
//! RATINGS_PLAN.md.
pub mod math;
pub mod ratings;
pub mod rules;
pub mod ticket;
pub use math::Rating;
pub use ratings::{
    GameResult, IRatings, IRatingsDispatcher, IRatingsDispatcherTrait, Player, RatingsComponent,
    admin_op,
};
pub use rules::{Pool, RatingRules, drift_of, elo, valid_pool};
pub use ticket::{Ticket, digest};

#[cfg(test)]
mod tests {
    mod bad;
    mod contract;
    mod rules;
    mod test_anchors;
    mod test_gas;
    mod test_math;
    mod test_ratings;
    mod test_rules;
    mod test_tickets;
    mod test_upgrade;
    mod test_vectors;
    mod vectors;
}
