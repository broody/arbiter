use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use referee::{Batch, Envelope, GameRules, Signature, Terms, context_hash, replay, state_hash};
use starknet::syscalls::{
    call_contract_syscall, get_class_hash_at_syscall, get_execution_info_v3_syscall,
    send_message_to_l1_syscall,
};
use starknet::{ContractAddress, SyscallResultTrait, get_contract_address, get_tx_info};
use crate::facts::check_facts;

/// The channel's `snapshot(game_id)`: terms, epoch, anchor hash, anchor block.
pub fn snapshot<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    channel: ContractAddress, game_id: felt252,
) -> (Terms<R::Config>, u32, felt252, u64) {
    let mut result = call_contract_syscall(channel, selector!("snapshot"), array![game_id].span())
        .unwrap_syscall();
    Serde::deserialize(ref result).expect('Malformed snapshot')
}

/// The L2→L1 payload a proved transition commits to.
pub fn payload<impl R: GameRules>(
    class_hash: felt252,
    prover: felt252,
    chain_id: felt252,
    channel: felt252,
    game_id: felt252,
    context: felt252,
    epoch: u32,
    start_hash: felt252,
    end_hash: felt252,
) -> Array<felt252> {
    array![
        class_hash, R::TAG, 'REFEREE_PROVED_V1', chain_id, prover, channel, game_id, context,
        epoch.into(), start_hash, end_hash,
    ]
}

/// The message hash proof facts carry for `payload` sent by `prover` to L1
/// address 0.
pub fn message_hash(prover: felt252, payload: Span<felt252>) -> felt252 {
    let mut encoded = array![prover, 0];
    payload.serialize(ref encoded);
    poseidon_hash_span(encoded.span())
}

/// Virtual `__execute__`: replay steps from the anchor against each seat's
/// final signature (and, in a timed game, the referee's attestation of the
/// stamps) and emit the transition message for the prover to prove.
pub fn execute<
    impl R: GameRules,
    +Serde<R::Config>,
    +Drop<R::Config>,
    +Serde<R::State>,
    +Copy<R::State>,
    +Drop<R::State>,
    +Serde<R::Action>,
    +Copy<R::Action>,
    +Drop<R::Action>,
    +Drop<R::Witness>,
    +Destruct<R::Scratch>,
>(
    channel: ContractAddress,
    game_id: felt252,
    epoch: u32,
    start: Envelope<R::State>,
    witness: R::Witness,
    batch: Batch<R::Action>,
) {
    assert_virtual();
    let (terms, anchor_hash, _) = checked_snapshot::<R>(channel, game_id, epoch);
    assert(state_hash::<R>(@start) == anchor_hash, 'Wrong proof anchor');
    let context = context_hash::<R>(@terms);
    let end = replay::<R>(context, @terms, start, witness, batch);
    let message = own_payload::<R>(@terms, context, epoch, anchor_hash, state_hash::<R>(@end));
    send_message_to_l1_syscall(0, message.span()).unwrap_syscall();
}

/// Real `settle`: check the attached proof facts commit to anchor → `end` for
/// this game and epoch, then hand `end` and the checkpoint approvals to the
/// channel.
pub fn settle<
    impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>, +Serde<R::State>, +Drop<R::State>,
>(
    channel: ContractAddress,
    game_id: felt252,
    epoch: u32,
    end: Envelope<R::State>,
    acks: Span<Signature>,
    os_program: felt252,
) {
    let (terms, anchor_hash, anchor_block) = checked_snapshot::<R>(channel, game_id, epoch);
    let context = context_hash::<R>(@terms);
    let message = own_payload::<R>(@terms, context, epoch, anchor_hash, state_hash::<R>(@end));
    let info = get_execution_info_v3_syscall().unwrap_syscall();
    check_facts(
        info.tx_info.proof_facts,
        message_hash(get_contract_address().into(), message.span()),
        os_program,
        info.block_info.block_number,
        anchor_block,
    );
    let mut calldata = array![game_id, epoch.into(), anchor_hash];
    end.serialize(ref calldata);
    acks.serialize(ref calldata);
    call_contract_syscall(channel, selector!("accept_verified"), calldata.span()).unwrap_syscall();
}

/// Only a zero-fee virtual INVOKE_V3 from the OS may run the proving path.
pub fn assert_virtual() {
    let info = starknet::get_execution_info();
    assert(info.caller_address.is_zero(), 'Only OS caller');
    assert(
        info.tx_info.version == 3 || info.tx_info.version == 0x100000000000000000000000000000003,
        'Only invoke v3',
    );
    assert(info.tx_info.tip == 0, 'Nonzero tip');
    for bound in info.tx_info.resource_bounds {
        assert(*bound.max_price_per_unit == 0, 'Nonzero gas price');
    }
}

fn checked_snapshot<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    channel: ContractAddress, game_id: felt252, epoch: u32,
) -> (Terms<R::Config>, felt252, u64) {
    let (terms, current, anchor_hash, anchor_block) = snapshot::<R>(channel, game_id);
    assert(terms.channel == channel.into() && terms.game_id == game_id, 'Wrong channel terms');
    assert(terms.chain_id == get_tx_info().chain_id, 'Wrong chain terms');
    assert(epoch == current, 'Stale proof epoch');
    assert(terms.prover == get_contract_address().into(), 'Wrong game prover');
    (terms, anchor_hash, anchor_block)
}

fn own_payload<impl R: GameRules>(
    terms: @Terms<R::Config>, context: felt252, epoch: u32, start_hash: felt252, end_hash: felt252,
) -> Array<felt252> {
    let address = get_contract_address();
    let class_hash = get_class_hash_at_syscall(address).unwrap_syscall();
    payload::<
        R,
    >(
        class_hash.into(),
        address.into(),
        *terms.chain_id,
        *terms.channel,
        *terms.game_id,
        context,
        epoch,
        start_hash,
        end_hash,
    )
}
