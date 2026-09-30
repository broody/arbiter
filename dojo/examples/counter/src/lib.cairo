//! The counter game as a Dojo world. The whole channel system is one line per
//! entrypoint on top of `referee_dojo::channel`.
use referee::{Batch, Envelope, Move, Signature, Terms};
use referee_counter::{Action, Config, Counter};
use referee_dojo::models::ChannelGame;

#[starknet::interface]
pub trait ICounterChannel<T> {
    /// Open a game on its terms and each seat's wallet signature over them.
    /// `referee_signature` is the referee's over its randomness tip when the
    /// terms take the referee's randomness, otherwise zero.
    fn open_game(
        ref self: T,
        terms: Terms<Config>,
        signatures: Span<Span<felt252>>,
        referee_signature: Signature,
    );
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
        batch: Batch<Action>,
        acks: Span<Signature>,
    );
    fn open_dispute(ref self: T, game_id: felt252, epoch: u32);
    /// The referee of a timed game is live during this dispute.
    fn acknowledge(ref self: T, game_id: felt252, epoch: u32, signature: Signature);
    fn resolve(ref self: T, game_id: felt252, epoch: u32);
    fn force(
        ref self: T,
        game_id: felt252,
        epoch: u32,
        start: Envelope<Counter>,
        steps: Span<Move<Action>>,
    );
    /// Post the referee's value for a roll that forced play waits for.
    fn roll(ref self: T, game_id: felt252, epoch: u32, start: Envelope<Counter>, value: felt252);
    /// End a game whose roll waits for a referee that is down, with no result.
    fn void(ref self: T, game_id: felt252, epoch: u32, acks: Span<Signature>);
    fn resume(ref self: T, game_id: felt252, epoch: u32, acks: Span<Signature>);
    /// A timed game's referee returns it from forced play on its own.
    fn resume_by_referee(ref self: T, game_id: felt252, epoch: u32, signature: Signature);
    fn claim_timeout(ref self: T, game_id: felt252, epoch: u32);
    fn resign(ref self: T, game_id: felt252);
    fn allow_prover(ref self: T, class_hash: felt252, allowed: bool);
    fn terms(self: @T, game_id: felt252) -> Terms<Config>;
    fn snapshot(self: @T, game_id: felt252) -> (Terms<Config>, u32, felt252, u64, felt252, u64);
    /// The stored channel, for clients and keepers watching disputes.
    fn get_channel(self: @T, game_id: felt252) -> ChannelGame;
}

#[dojo::contract]
pub mod channel {
    use dojo::world::WorldStorage;
    use referee::{Batch, Envelope, Move, Signature, Terms};
    use referee_counter::{Action, Config, Counter, CounterRules};
    use referee_dojo::channel as binding;
    use referee_dojo::models::ChannelGame;

    #[abi(embed_v0)]
    impl CounterChannelImpl of super::ICounterChannel<ContractState> {
        fn open_game(
            ref self: ContractState,
            terms: Terms<Config>,
            signatures: Span<Span<felt252>>,
            referee_signature: Signature,
        ) {
            let mut world = self.world_default();
            binding::open_game::<CounterRules>(ref world, terms, signatures, referee_signature);
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
            batch: Batch<Action>,
            acks: Span<Signature>,
        ) {
            let mut world = self.world_default();
            binding::submit_history::<
                CounterRules,
            >(ref world, game_id, epoch, start, (), batch, acks);
        }

        fn open_dispute(ref self: ContractState, game_id: felt252, epoch: u32) {
            let mut world = self.world_default();
            binding::open_dispute(ref world, game_id, epoch);
        }

        fn acknowledge(
            ref self: ContractState, game_id: felt252, epoch: u32, signature: Signature,
        ) {
            let mut world = self.world_default();
            binding::acknowledge::<CounterRules>(ref world, game_id, epoch, signature);
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
            steps: Span<Move<Action>>,
        ) {
            let mut world = self.world_default();
            binding::force::<CounterRules>(ref world, game_id, epoch, start, (), steps);
        }

        fn roll(
            ref self: ContractState,
            game_id: felt252,
            epoch: u32,
            start: Envelope<Counter>,
            value: felt252,
        ) {
            let mut world = self.world_default();
            binding::roll::<CounterRules>(ref world, game_id, epoch, start, (), value);
        }

        fn void(ref self: ContractState, game_id: felt252, epoch: u32, acks: Span<Signature>) {
            let mut world = self.world_default();
            binding::void::<CounterRules>(ref world, game_id, epoch, acks);
        }

        fn resume(ref self: ContractState, game_id: felt252, epoch: u32, acks: Span<Signature>) {
            let mut world = self.world_default();
            binding::resume::<CounterRules>(ref world, game_id, epoch, acks);
        }

        fn resume_by_referee(
            ref self: ContractState, game_id: felt252, epoch: u32, signature: Signature,
        ) {
            let mut world = self.world_default();
            binding::resume_by_referee::<CounterRules>(ref world, game_id, epoch, signature);
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

        fn snapshot(
            self: @ContractState, game_id: felt252,
        ) -> (Terms<Config>, u32, felt252, u64, felt252, u64) {
            let world = self.world_default();
            binding::snapshot::<CounterRules>(@world, game_id)
        }

        fn get_channel(self: @ContractState, game_id: felt252) -> ChannelGame {
            let world = self.world_default();
            binding::read(@world, game_id)
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
mod account;
#[cfg(test)]
mod tests;
