//! Proof adapter for the counter game: a thin account contract over
//! `arbiter_adapter`. Deploy one instance per Starknet OS program and
//! allowlist its class in the game's channel.
use arbiter::{Batch, Envelope, Signature, Terms};
use arbiter_counter::{Action, Config, Counter};
use starknet::ContractAddress;

#[starknet::interface]
pub trait ICounterProver<T> {
    /// `start_hash` is the channel's anchor or candidate the proof starts from.
    fn settle(
        ref self: T,
        channel: ContractAddress,
        game_id: felt252,
        epoch: u32,
        start_hash: felt252,
        end: Envelope<Counter>,
        acks: Span<Signature>,
    );
    fn os_program(self: @T) -> felt252;
}

#[starknet::interface]
pub trait IVirtualCounter<T> {
    fn __validate__(
        self: @T,
        channel: ContractAddress,
        game_id: felt252,
        epoch: u32,
        start: Envelope<Counter>,
        batch: Batch<Action>,
        opening: Option<Terms<Config>>,
    ) -> felt252;
    /// `opening` is the terms of a game no channel has opened yet, `None`
    /// otherwise: the proof then starts from their opening state.
    fn __execute__(
        ref self: T,
        channel: ContractAddress,
        game_id: felt252,
        epoch: u32,
        start: Envelope<Counter>,
        batch: Batch<Action>,
        opening: Option<Terms<Config>>,
    );
}

#[starknet::contract(account)]
pub mod CounterProver {
    use arbiter::{Batch, Envelope, Signature, Terms};
    use arbiter_adapter::prover;
    use arbiter_counter::{Action, Config, Counter, CounterRules};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, VALIDATED};

    // No admin, upgrade path, arbitrary calls or custody. The virtual OS
    // program is fixed at deployment; an OS upgrade needs a new instance.
    #[storage]
    struct Storage {
        os_program: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, os_program: felt252) {
        assert(os_program != 0, 'Zero OS program');
        self.os_program.write(os_program);
    }

    #[abi(embed_v0)]
    impl ProverImpl of super::ICounterProver<ContractState> {
        fn settle(
            ref self: ContractState,
            channel: ContractAddress,
            game_id: felt252,
            epoch: u32,
            start_hash: felt252,
            end: Envelope<Counter>,
            acks: Span<Signature>,
        ) {
            prover::settle::<
                CounterRules,
            >(channel, game_id, epoch, start_hash, end, acks, self.os_program.read());
        }

        fn os_program(self: @ContractState) -> felt252 {
            self.os_program.read()
        }
    }

    #[abi(embed_v0)]
    impl VirtualImpl of super::IVirtualCounter<ContractState> {
        fn __validate__(
            self: @ContractState,
            channel: ContractAddress,
            game_id: felt252,
            epoch: u32,
            start: Envelope<Counter>,
            batch: Batch<Action>,
            opening: Option<Terms<Config>>,
        ) -> felt252 {
            prover::assert_virtual();
            VALIDATED
        }

        fn __execute__(
            ref self: ContractState,
            channel: ContractAddress,
            game_id: felt252,
            epoch: u32,
            start: Envelope<Counter>,
            batch: Batch<Action>,
            opening: Option<Terms<Config>>,
        ) {
            prover::execute::<CounterRules>(channel, game_id, epoch, start, (), batch, opening);
        }
    }
}
