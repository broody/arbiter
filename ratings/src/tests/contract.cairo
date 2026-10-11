/// A game's ratings contract as the tests deploy it: the component with
/// `TestRules`, as Surround's `SurroundRatings` embeds it with its rules.
#[starknet::contract]
pub mod TestRatings {
    use starknet::ContractAddress;
    use crate::ratings::RatingsComponent;
    use crate::tests::rules::TestRules;

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
