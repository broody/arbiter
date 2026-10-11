//! The counter as a rated game. Its config carries a pairing ticket
//! (`RatedConfig`), its ratings contract is `arbiter_ratings`' component with
//! its own `RatingRules` (two pools, Elo-scale ranks), and its channel opens
//! rated games on matchmaker-signed tickets and reports them for rating, one
//! line per entrypoint on top of `arbiter_dojo`.
use arbiter::{Approval, Batch, Envelope, GameRules, RatedConfig, Signature, Terms};
use arbiter_counter::{Action, Counter, CounterRules};
use arbiter_dojo::models::ChannelGame;
use arbiter_ratings::math::ONE;
use arbiter_ratings::{GameResult, Player, Pool, RatingRules, Ticket, drift_of, elo};
use starknet::ContractAddress;

/// The longest a delegation `open_rated_game_delegable` takes may still have
/// to run.
pub const DELEGATION_SECONDS: u64 = 7 * 24 * 3600;
pub const BLITZ: felt252 = 'blitz';
pub const RAPID: felt252 = 'rapid';

/// The counter's config, with the ticket of a rated game (0: unrated).
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Config {
    pub target: u8,
    pub ticket: felt252,
}

pub impl Rated of RatedConfig<Config> {
    fn ticket(self: @Config) -> felt252 {
        *self.ticket
    }

    fn with_ticket(self: @Config, ticket: felt252) -> Config {
        Config { ticket, ..*self }
    }
}

fn counter(config: @Config) -> arbiter_counter::Config {
    arbiter_counter::Config { target: *config.target }
}

/// The counter's rules on the rated config.
pub impl RatedCounterRules of GameRules {
    type Config = Config;
    type State = Counter;
    type Action = Action;
    type Witness = ();
    type Scratch = ();

    const TAG: felt252 = 'RATED_COUNTER';
    const RULES_VERSION: u32 = 1;
    const SEATS: u8 = 2;
    impl Time = arbiter::clocks::StandardTime<Counter>;

    fn init(config: @Config) -> Counter {
        CounterRules::init(@counter(config))
    }

    fn load(config: @Config, state: @Counter, witness: ()) -> () {}

    fn apply(
        config: @Config, ref scratch: (), state: Counter, seat: u8, action: Action,
    ) -> (Counter, Option<u8>) {
        CounterRules::apply(@counter(config), ref scratch, state, seat, action)
    }

    fn resolve(config: @Config, ref scratch: (), state: Counter, seed: felt252) -> Counter {
        CounterRules::resolve(@counter(config), ref scratch, state, seed)
    }

    fn due(state: @Counter) -> u8 {
        CounterRules::due(state)
    }

    fn outcome(state: @Counter) -> Option<(u8, u8)> {
        CounterRules::outcome(state)
    }

    fn max_steps(config: @Config) -> u32 {
        CounterRules::max_steps(@counter(config))
    }

    fn adjudicate(config: @Config, state: @Counter) -> (u8, u8) {
        CounterRules::adjudicate(@counter(config), state)
    }
}

/// The counter's ratings: blitz and rapid pools, flat aging with a 30-day
/// half-life, Elo-scale ranks, and bands at 1200, 1500 and 1800.
pub impl CounterRatingRules of RatingRules {
    const TAG: felt252 = 'RATED_COUNTER';
    const VERSION: u8 = 1;
    const REFEREE_RNG: bool = false;

    fn pool(pool: felt252) -> Option<Pool> {
        if pool != BLITZ && pool != RAPID {
            return Option::None;
        }
        Option::Some(
            Pool {
                phi0: 2 * ONE,
                min_phi: 42949673,
                mu_min: -34613345405,
                mu_max: 49447636293,
                provisional_phi: ONE,
                settled_games: 10,
                min_steps: 4,
                anchor_phi: ONE / 4,
                anchor_mu_min: -24105722693,
                anchor_mu_max: 32884882086,
                max_offset: 400,
            },
        )
    }

    fn start(pool: felt252, band: u8) -> Option<i128> {
        match band {
            1 => Option::Some(-7417145753),
            2 => Option::Some(0),
            3 => Option::Some(7417145753),
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

/// The counter's ratings contract: the component with its rules.
#[starknet::contract]
pub mod CounterRatings {
    use arbiter_ratings::RatingsComponent;
    use starknet::ContractAddress;
    use super::CounterRatingRules;

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

#[starknet::interface]
pub trait IRatedChannel<T> {
    /// Open an unrated game; a config with a ticket opens only as rated.
    fn open_game(ref self: T, terms: Terms<Config>, signatures: Span<Span<felt252>>);
    /// Open a rated game on its matchmaker's signed ticket.
    fn open_rated_game(
        ref self: T,
        terms: Terms<Config>,
        signatures: Span<Span<felt252>>,
        ticket: Ticket,
        signature: Signature,
    );
    fn open_rated_game_delegable(
        ref self: T,
        terms: Terms<Config>,
        approvals: Span<Approval>,
        ticket: Ticket,
        signature: Signature,
    );
    fn submit_history(
        ref self: T,
        game_id: felt252,
        epoch: u32,
        start: Envelope<Counter>,
        batch: Batch<Action>,
        acks: Span<Signature>,
    );
    fn resign(ref self: T, game_id: felt252);
    /// Report a settled rated game for rating. Anyone may.
    fn rate(ref self: T, game_id: felt252, ticket: Ticket) -> Option<(GameResult, Player, Player)>;
    fn allow_prover(ref self: T, class_hash: felt252, allowed: bool);
    /// The ratings contract, set once by the namespace owner.
    fn set_ratings(ref self: T, ratings: ContractAddress);
    fn ratings(self: @T) -> ContractAddress;
    fn get_channel(self: @T, game_id: felt252) -> ChannelGame;
}

#[dojo::contract]
pub mod channel {
    use arbiter::{Approval, Batch, Envelope, Signature, Terms};
    use arbiter_counter::{Action, Counter};
    use arbiter_dojo::models::ChannelGame;
    use arbiter_dojo::{channel as binding, rated};
    use arbiter_ratings::{GameResult, Player, Ticket};
    use core::num::traits::Zero;
    use dojo::world::{IWorldDispatcherTrait, WorldStorage};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::{Config, CounterRatingRules, DELEGATION_SECONDS, RatedCounterRules};

    #[storage]
    struct Storage {
        ratings: ContractAddress,
    }

    #[abi(embed_v0)]
    impl RatedChannelImpl of super::IRatedChannel<ContractState> {
        fn open_game(
            ref self: ContractState, terms: Terms<Config>, signatures: Span<Span<felt252>>,
        ) {
            let mut world = self.world_default();
            binding::open_game::<
                RatedCounterRules,
            >(ref world, terms, signatures, Signature { r: 0, s: 0 });
        }

        fn open_rated_game(
            ref self: ContractState,
            terms: Terms<Config>,
            signatures: Span<Span<felt252>>,
            ticket: Ticket,
            signature: Signature,
        ) {
            let mut world = self.world_default();
            rated::open_rated_game::<
                RatedCounterRules, CounterRatingRules,
            >(
                ref world,
                self.ratings.read(),
                terms,
                signatures,
                Signature { r: 0, s: 0 },
                ticket,
                signature,
            );
        }

        fn open_rated_game_delegable(
            ref self: ContractState,
            terms: Terms<Config>,
            approvals: Span<Approval>,
            ticket: Ticket,
            signature: Signature,
        ) {
            let mut world = self.world_default();
            rated::open_rated_game_delegable::<
                RatedCounterRules, CounterRatingRules,
            >(
                ref world,
                self.ratings.read(),
                terms,
                approvals,
                Signature { r: 0, s: 0 },
                DELEGATION_SECONDS,
                ticket,
                signature,
            );
        }

        fn submit_history(
            ref self: ContractState,
            game_id: felt252,
            epoch: u32,
            start: Envelope<Counter>,
            batch: Batch<Action>,
            acks: Span<Signature>,
        ) {
            let mut world = self.world_default();
            binding::submit_history::<
                RatedCounterRules,
            >(ref world, game_id, epoch, start, (), batch, acks);
        }

        fn resign(ref self: ContractState, game_id: felt252) {
            let mut world = self.world_default();
            binding::resign(ref world, game_id);
        }

        fn rate(
            ref self: ContractState, game_id: felt252, ticket: Ticket,
        ) -> Option<(GameResult, Player, Player)> {
            let world = self.world_default();
            rated::rate::<CounterRatingRules>(@world, self.ratings.read(), game_id, ticket)
        }

        fn allow_prover(ref self: ContractState, class_hash: felt252, allowed: bool) {
            let mut world = self.world_default();
            binding::allow_prover(ref world, class_hash, allowed);
        }

        fn set_ratings(ref self: ContractState, ratings: ContractAddress) {
            let world = self.world_default();
            assert(
                world.dispatcher.is_owner(world.namespace_hash, get_caller_address()),
                'Only namespace owner',
            );
            assert(self.ratings.read().is_zero(), 'Ratings already set');
            assert(ratings.is_non_zero(), 'Zero ratings');
            self.ratings.write(ratings);
        }

        fn ratings(self: @ContractState) -> ContractAddress {
            self.ratings.read()
        }

        fn get_channel(self: @ContractState, game_id: felt252) -> ChannelGame {
            binding::read(@self.world_default(), game_id)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn world_default(self: @ContractState) -> WorldStorage {
            self.world(@"rated")
        }
    }
}

#[cfg(test)]
mod account;
#[cfg(test)]
mod rolled;
#[cfg(test)]
mod tests;
