use arbiter::{Batch, Envelope, GameRules, Signature, Terms, context_hash, open, replay, state_hash};
use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use starknet::syscalls::{
    call_contract_syscall, get_class_hash_at_syscall, get_execution_info_v3_syscall,
    send_message_to_l1_syscall,
};
use starknet::{ContractAddress, SyscallResultTrait, get_contract_address, get_tx_info};
use crate::facts::check_facts;

/// The channel's `snapshot(game_id)`: terms, epoch, and the hash and block of
/// the anchor and of the candidate, the two states a proof may start from.
pub fn snapshot<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    channel: ContractAddress, game_id: felt252,
) -> (Terms<R::Config>, u32, felt252, u64, felt252, u64) {
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
        class_hash, R::TAG, 'ARBITER_PROVED_V1', chain_id, prover, channel, game_id, context,
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

/// Virtual `__execute__`: replay steps from the anchor, or from the candidate
/// to extend it, against each seat's final signature (and, in a timed game,
/// the referee's attestation of the stamps) and emit the transition message
/// for the prover to prove. For a game no channel has opened yet, `opening`
/// is its terms: the proof starts from their opening state at epoch 0, and
/// `settle` goes in one transaction with the call that opens the game.
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
    opening: Option<Terms<R::Config>>,
) {
    assert_virtual();
    let start_hash = state_hash::<R>(@start);
    let terms = match opening {
        Option::Some(terms) => {
            // Nothing to read onchain: the terms fix the opening state.
            check_terms::<R>(@terms, channel, game_id);
            assert(epoch == 0, 'Stale proof epoch');
            assert(start_hash == state_hash::<R>(@open::<R>(@terms)), 'Wrong proof anchor');
            terms
        },
        Option::None => {
            let (terms, _) = checked_snapshot::<R>(channel, game_id, epoch, start_hash);
            terms
        },
    };
    let context = context_hash::<R>(@terms);
    let end = replay::<R>(context, @terms, start, witness, batch);
    let message = own_payload::<R>(@terms, context, epoch, start_hash, state_hash::<R>(@end));
    send_message_to_l1_syscall(0, message.span()).unwrap_syscall();
}

/// Real `settle`: check the attached proof facts commit to `start_hash` → `end`
/// for this game and epoch, where `start_hash` is the channel's anchor or
/// candidate and the proof is based at or after the block it was set in, then
/// hand `end` and the checkpoint approvals to the channel. At epoch 0 the
/// anchor is the opening state, which the terms fix, so a proof from it may be
/// based before the game opened: in the same transaction, say.
pub fn settle<
    impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>, +Serde<R::State>, +Drop<R::State>,
>(
    channel: ContractAddress,
    game_id: felt252,
    epoch: u32,
    start_hash: felt252,
    end: Envelope<R::State>,
    acks: Span<Signature>,
    os_program: felt252,
) {
    let (terms, base_block) = checked_snapshot::<R>(channel, game_id, epoch, start_hash);
    let context = context_hash::<R>(@terms);
    let message = own_payload::<R>(@terms, context, epoch, start_hash, state_hash::<R>(@end));
    let info = get_execution_info_v3_syscall().unwrap_syscall();
    check_facts(
        info.tx_info.proof_facts,
        message_hash(get_contract_address().into(), message.span()),
        os_program,
        info.block_info.block_number,
        base_block,
    );
    let mut calldata = array![game_id, epoch.into(), start_hash];
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

// The channel's terms and the block a proof from `start_hash`, the anchor or
// the candidate, must be based at or after: where that state was set, except
// the opening state at epoch 0, which the terms fix.
fn checked_snapshot<impl R: GameRules, +Serde<R::Config>, +Drop<R::Config>>(
    channel: ContractAddress, game_id: felt252, epoch: u32, start_hash: felt252,
) -> (Terms<R::Config>, u64) {
    let (terms, current, anchor_hash, anchor_block, candidate_hash, candidate_block) = snapshot::<
        R,
    >(channel, game_id);
    check_terms::<R>(@terms, channel, game_id);
    assert(epoch == current, 'Stale proof epoch');
    let block = if start_hash == anchor_hash {
        if epoch == 0 {
            0
        } else {
            anchor_block
        }
    } else {
        assert(start_hash == candidate_hash, 'Wrong proof anchor');
        candidate_block
    };
    (terms, block)
}

// Terms for this game, on this chain, proved by this adapter.
fn check_terms<impl R: GameRules>(
    terms: @Terms<R::Config>, channel: ContractAddress, game_id: felt252,
) {
    assert(*terms.channel == channel.into() && *terms.game_id == game_id, 'Wrong channel terms');
    assert(*terms.chain_id == get_tx_info().chain_id, 'Wrong chain terms');
    assert(*terms.prover == get_contract_address().into(), 'Wrong game prover');
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
