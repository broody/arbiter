//! The counter game as a Dojo world. The whole channel system is one line per
//! entrypoint on top of `referee_dojo::channel`.
use referee::{Envelope, Signature, SignedStep, Step, Terms};
use referee_counter::{Action, Config, Counter};
use starknet::ContractAddress;

#[starknet::interface]
pub trait ICounterChannel<T> {
    fn create(
        ref self: T,
        target: u8,
        invited: ContractAddress,
        session_key: felt252,
        rng_tip: felt252,
        prover: ContractAddress,
        response_seconds: u32,
    ) -> felt252;
    fn join(ref self: T, game_id: felt252, session_key: felt252, rng_tip: felt252);
    fn cancel(ref self: T, game_id: felt252);
    fn accept_verified(
        ref self: T,
        game_id: felt252,
        epoch: u32,
        start_hash: felt252,
        end: Envelope<Counter>,
        acks: Span<Signature>,
    );
    fn submit_history(
        ref self: T,
        game_id: felt252,
        epoch: u32,
        start: Envelope<Counter>,
        steps: Span<SignedStep<Action>>,
        acks: Span<Signature>,
    );
    fn open_dispute(ref self: T, game_id: felt252, epoch: u32);
    fn resolve(ref self: T, game_id: felt252, epoch: u32);
    fn force(
        ref self: T,
        game_id: felt252,
        epoch: u32,
        start: Envelope<Counter>,
        steps: Span<Step<Action>>,
    );
    fn resume(ref self: T, game_id: felt252, epoch: u32, acks: Span<Signature>);
    fn claim_timeout(ref self: T, game_id: felt252, epoch: u32);
    fn resign(ref self: T, game_id: felt252);
    fn allow_prover(ref self: T, class_hash: felt252, allowed: bool);
    fn terms(self: @T, game_id: felt252) -> Terms<Config>;
    fn snapshot(self: @T, game_id: felt252) -> (Terms<Config>, u32, felt252, u64);
}

#[dojo::contract]
pub mod channel {
    use dojo::world::WorldStorage;
    use referee::{Envelope, Signature, SignedStep, Step, Terms};
    use referee_counter::{Action, Config, Counter, CounterRules};
    use referee_dojo::channel as binding;
    use starknet::ContractAddress;

    #[abi(embed_v0)]
    impl CounterChannelImpl of super::ICounterChannel<ContractState> {
        fn create(
            ref self: ContractState,
            target: u8,
            invited: ContractAddress,
            session_key: felt252,
            rng_tip: felt252,
            prover: ContractAddress,
            response_seconds: u32,
        ) -> felt252 {
            let mut world = self.world_default();
            binding::create::<
                CounterRules,
            >(ref world, Config { target }, invited, session_key, rng_tip, prover, response_seconds)
        }

        fn join(ref self: ContractState, game_id: felt252, session_key: felt252, rng_tip: felt252) {
            let mut world = self.world_default();
            binding::join::<CounterRules>(ref world, game_id, session_key, rng_tip);
        }

        fn cancel(ref self: ContractState, game_id: felt252) {
            let mut world = self.world_default();
            binding::cancel(ref world, game_id);
        }

        fn accept_verified(
            ref self: ContractState,
            game_id: felt252,
            epoch: u32,
            start_hash: felt252,
            end: Envelope<Counter>,
            acks: Span<Signature>,
        ) {
            let mut world = self.world_default();
            binding::accept_verified::<
                CounterRules,
            >(ref world, game_id, epoch, start_hash, end, acks);
        }

        fn submit_history(
            ref self: ContractState,
            game_id: felt252,
            epoch: u32,
            start: Envelope<Counter>,
            steps: Span<SignedStep<Action>>,
            acks: Span<Signature>,
        ) {
            let mut world = self.world_default();
            binding::submit_history::<
                CounterRules,
            >(ref world, game_id, epoch, start, (), steps, acks);
        }

        fn open_dispute(ref self: ContractState, game_id: felt252, epoch: u32) {
            let mut world = self.world_default();
            binding::open_dispute(ref world, game_id, epoch);
        }

        fn resolve(ref self: ContractState, game_id: felt252, epoch: u32) {
            let mut world = self.world_default();
            binding::resolve(ref world, game_id, epoch);
        }

        fn force(
            ref self: ContractState,
            game_id: felt252,
            epoch: u32,
            start: Envelope<Counter>,
            steps: Span<Step<Action>>,
        ) {
            let mut world = self.world_default();
            binding::force::<CounterRules>(ref world, game_id, epoch, start, (), steps);
        }

        fn resume(ref self: ContractState, game_id: felt252, epoch: u32, acks: Span<Signature>) {
            let mut world = self.world_default();
            binding::resume::<CounterRules>(ref world, game_id, epoch, acks);
        }

        fn claim_timeout(ref self: ContractState, game_id: felt252, epoch: u32) {
            let mut world = self.world_default();
            binding::claim_timeout(ref world, game_id, epoch);
        }

        fn resign(ref self: ContractState, game_id: felt252) {
            let mut world = self.world_default();
            binding::resign(ref world, game_id);
        }

        fn allow_prover(ref self: ContractState, class_hash: felt252, allowed: bool) {
            let mut world = self.world_default();
            binding::allow_prover(ref world, class_hash, allowed);
        }

        fn terms(self: @ContractState, game_id: felt252) -> Terms<Config> {
            let world = self.world_default();
            binding::terms::<CounterRules>(@binding::read(@world, game_id))
        }

        fn snapshot(self: @ContractState, game_id: felt252) -> (Terms<Config>, u32, felt252, u64) {
            let world = self.world_default();
            binding::snapshot::<CounterRules>(@world, game_id)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn world_default(self: @ContractState) -> WorldStorage {
            self.world(@"counter")
        }
    }
}

#[cfg(test)]
mod tests;
