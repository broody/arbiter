//! The counter rated with its dice rolled by its referee, for the tests: rules
//! with `REFEREE_RNG` under the same tag, so the same ratings contract takes
//! their tickets, and a channel that opens rated games with the referee's
//! signature over its randomness tip.
use arbiter::{Signature, Terms};
use arbiter_ratings::{Pool, RatingRules, Ticket};
use starknet::ContractAddress;
use crate::{Config, CounterRatingRules};

pub impl RolledRatingRules of RatingRules {
    const TAG: felt252 = CounterRatingRules::TAG;
    const VERSION: u8 = CounterRatingRules::VERSION;
    const REFEREE_RNG: bool = true;

    fn pool(pool: felt252) -> Option<Pool> {
        CounterRatingRules::pool(pool)
    }

    fn start(pool: felt252, band: u8) -> Option<i128> {
        CounterRatingRules::start(pool, band)
    }

    fn drift(pool: felt252, mu: i128) -> i128 {
        CounterRatingRules::drift(pool, mu)
    }

    fn shown(pool: felt252, mu: i128, offset: i32) -> u16 {
        CounterRatingRules::shown(pool, mu, offset)
    }
}

#[starknet::interface]
pub trait IRolledChannel<T> {
    fn open_rated_game(
        ref self: T,
        terms: Terms<Config>,
        signatures: Span<Span<felt252>>,
        referee_signature: Signature,
        ticket: Ticket,
        signature: Signature,
    );
    fn set_ratings(ref self: T, ratings: ContractAddress);
}

#[dojo::contract]
pub mod rolled_channel {
    use arbiter::{Signature, Terms};
    use arbiter_dojo::rated;
    use arbiter_ratings::Ticket;
    use dojo::world::WorldStorage;
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use crate::{Config, RatedCounterRules};
    use super::RolledRatingRules;

    #[storage]
    struct Storage {
        ratings: ContractAddress,
    }

    #[abi(embed_v0)]
    impl RolledChannelImpl of super::IRolledChannel<ContractState> {
        fn open_rated_game(
            ref self: ContractState,
            terms: Terms<Config>,
            signatures: Span<Span<felt252>>,
            referee_signature: Signature,
            ticket: Ticket,
            signature: Signature,
        ) {
            let mut world = self.world_default();
            rated::open_rated_game::<
                RatedCounterRules, RolledRatingRules,
            >(
                ref world,
                self.ratings.read(),
                terms,
                signatures,
                referee_signature,
                ticket,
                signature,
            );
        }

        fn set_ratings(ref self: ContractState, ratings: ContractAddress) {
            self.ratings.write(ratings);
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn world_default(self: @ContractState) -> WorldStorage {
            self.world(@"rated")
        }
    }
}
