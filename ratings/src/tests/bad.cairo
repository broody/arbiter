//! A game whose one pool doesn't fit the packed player state (φ0 at 4), and
//! its ratings contract, for the tests: its tickets are refused.
use crate::math::ONE;
use crate::rules::{Pool, RatingRules, drift_of, elo};
use crate::tests::rules::test_pool;

pub const BAD: felt252 = 'bad';

pub impl BadRules of RatingRules {
    const TAG: felt252 = 'BAD';
    const VERSION: u8 = 1;
    const REFEREE_RNG: bool = false;

    fn pool(pool: felt252) -> Option<Pool> {
        if pool == BAD {
            Option::Some(Pool { phi0: 4 * ONE, ..test_pool() })
        } else {
            Option::None
        }
    }

    fn start(pool: felt252, band: u8) -> Option<i128> {
        if band == 3 {
            Option::Some(0)
        } else {
            Option::None
        }
    }

    fn drift(pool: felt252, mu: i128) -> i128 {
        drift_of(30 * ONE)
    }

    fn shown(pool: felt252, mu: i128, offset: i32) -> u16 {
        elo(mu, offset)
    }
}

#[starknet::contract]
pub mod BadRatings {
    use starknet::ContractAddress;
    use crate::ratings::RatingsComponent;
    use super::BadRules;

    component!(path: RatingsComponent, storage: ratings, event: RatingsEvent);

    #[abi(embed_v0)]
    impl RatingsImpl = RatingsComponent::Ratings<ContractState>;
    impl RatingsInternal = RatingsComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ratings: RatingsComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        RatingsEvent: RatingsComponent::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.ratings.initializer(owner);
    }
}
