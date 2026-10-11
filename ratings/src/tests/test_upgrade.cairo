//! An upgrade changes the rules under tickets already accepted. A game whose
//! pool or new player's band the new rules dropped is voided when it reports,
//! so its ticket never stays accepted forever; the rest rate as before.
use starknet::testing::{set_block_timestamp, set_contract_address};
use crate::math::ONE;
use crate::ratings::{IRatingsDispatcherTrait, QUEUE, RATED, VOID};
use crate::rules::{Pool, RatingRules, drift_of, elo};
use crate::tests::rules::{BLITZ, RAPID, test_pool};
use crate::tests::test_ratings::{T0, accept, alice, bob, owner, result, setup, status, ticket_for};
use crate::ticket::Ticket;

/// `TestRules` after an upgrade: the rapid pool and bands 5 and 7 dropped.
pub impl NarrowRules of RatingRules {
    const TAG: felt252 = 'TEST';
    const VERSION: u8 = 2;
    const REFEREE_RNG: bool = false;

    fn pool(pool: felt252) -> Option<Pool> {
        if pool == BLITZ {
            Option::Some(test_pool())
        } else {
            Option::None
        }
    }

    fn start(pool: felt252, band: u8) -> Option<i128> {
        match band {
            1 => Option::Some(-17306673424),
            2 => Option::Some(-7417145753),
            3 => Option::Some(0),
            4 => Option::Some(7417145753),
            _ => Option::None,
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
pub mod NarrowRatings {
    use starknet::ContractAddress;
    use crate::ratings::RatingsComponent;
    use super::NarrowRules;

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

fn narrow(ratings: crate::ratings::IRatingsDispatcher) {
    set_contract_address(owner());
    ratings.upgrade(NarrowRatings::TEST_CLASS_HASH);
}

#[test]
fn a_dropped_band_voids_a_new_players_pending_game() {
    let ratings = setup();
    let t = T0 + 3600;
    let ticket = accept(
        ratings, Ticket { band_0: 5, ..ticket_for(1, t, alice(), bob(), QUEUE) }, 1,
    );
    narrow(ratings);
    let game = result(1, t, 1);
    set_contract_address(crate::tests::test_ratings::channel());
    assert!(ratings.rate_game(ticket, game).is_none());
    assert_eq!(status(ratings, @ticket), VOID);
    assert_eq!(ratings.player(BLITZ, alice()).games, 0);
}

#[test]
fn a_dropped_pool_voids_its_pending_games() {
    let ratings = setup();
    let t = T0 + 3600;
    let ticket = accept(
        ratings, Ticket { pool: RAPID, ..ticket_for(1, t, alice(), bob(), QUEUE) }, 1,
    );
    narrow(ratings);
    let game = result(1, t, 1);
    set_contract_address(crate::tests::test_ratings::channel());
    assert!(ratings.rate_game(ticket, game).is_none());
    assert_eq!(status(ratings, @ticket), VOID);
}

#[test]
fn a_game_the_upgrade_left_alone_still_rates() {
    let ratings = setup();
    let t = T0 + 3600;
    let ticket = accept(ratings, ticket_for(1, t, alice(), bob(), QUEUE), 1);
    narrow(ratings);
    let game = result(1, t, 1);
    set_block_timestamp(game.settled_at);
    set_contract_address(crate::tests::test_ratings::channel());
    let (a, _) = ratings.rate_game(ticket, game).unwrap();
    assert_eq!((status(ratings, @ticket), a.params), (RATED, 2));
}
