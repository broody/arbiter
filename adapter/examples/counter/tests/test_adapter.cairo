//! The counter proof adapter against a mock channel. The virtual `__execute__`
//! replays a signed game and emits the transition message; `settle` accepts
//! exactly that message as proof facts and relays the end state. Proof facts
//! are cheated here; a real run attaches a native Stwo proof instead.
use referee::{
    Batch, Envelope, Move, Signature, Terms, TimeControl, action_hash, actor, apply_steps,
    context_hash, open, stamp_hash, state_hash,
};
use referee_adapter::{ProofFacts, check_facts, message_hash, payload};
use referee_counter::{ADD, Action, Config, Counter, CounterRules};
use referee_counter_adapter::{
    ICounterProverDispatcher, ICounterProverDispatcherTrait, IVirtualCounterDispatcher,
    IVirtualCounterDispatcherTrait,
};
use referee_testing::{chain_value, public_key, sign};
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, MessageToL1, MessageToL1SpyAssertionsTrait,
    cheat_proof_facts, cheat_resource_bounds, declare, get_class_hash, spy_messages_to_l1,
    start_cheat_block_number, start_cheat_caller_address, start_cheat_chain_id,
    start_cheat_transaction_version,
};
use starknet::{ContractAddress, ResourcesBounds, SyscallResultTrait};

const OS_PROGRAM: felt252 = 123;
const GAME: felt252 = 17;
const PK_A: felt252 = 0x1a2b3c;
const PK_B: felt252 = 0x4d5e6f;
const PK_REF: felt252 = 0x7e7e7e;
const RNG_LEN: u32 = 16;

pub fn terms(channel: ContractAddress, game_id: felt252, prover: ContractAddress) -> Terms<Config> {
    terms_for(channel, game_id, prover, false)
}

/// The mock channel's terms; a timed game has a referee (PK_REF) and a 30 s
/// turn, 60 s bank and 2 s increment.
pub fn terms_for(
    channel: ContractAddress, game_id: felt252, prover: ContractAddress, timed: bool,
) -> Terms<Config> {
    let clock = if timed {
        Option::Some(
            TimeControl {
                referee: public_key(PK_REF), turn_ms: 30000, bank_ms: 60000, increment_ms: 2000,
            },
        )
    } else {
        Option::None
    };
    Terms {
        chain_id: 'SN_SEPOLIA',
        channel: channel.into(),
        game_id,
        prover: prover.into(),
        response_seconds: 3600,
        clock,
        players: array![4, 5].span(),
        keys: array![public_key(PK_A), public_key(PK_B)].span(),
        rng_tips: array![chain_value(0x5eed0, RNG_LEN), chain_value(0x5eed1, RNG_LEN)].span(),
        config: Config { target: 20 },
    }
}

pub fn opening(terms: @Terms<Config>) -> Envelope<Counter> {
    open::<CounterRules>(terms)
}

#[starknet::interface]
trait IMockChannel<T> {
    fn configure(ref self: T, prover: ContractAddress);
    fn set_timed(ref self: T, timed: bool);
    fn snapshot(self: @T, game_id: felt252) -> (Terms<Config>, u32, felt252, u64);
    fn accept_verified(
        ref self: T,
        game_id: felt252,
        epoch: u32,
        start_hash: felt252,
        end: Envelope<Counter>,
        acks: Span<Signature>,
    );
    fn accepted(self: @T) -> felt252;
}

/// Stands in for a referee_dojo game system: epoch 0, anchored at the opening
/// state in block 10.
#[starknet::contract]
mod MockChannel {
    use referee::{Envelope, Signature, Terms, state_hash};
    use referee_counter::{Config, Counter, CounterRules};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};

    #[storage]
    struct Storage {
        prover: ContractAddress,
        timed: bool,
        accepted: felt252,
    }

    #[abi(embed_v0)]
    impl MockImpl of super::IMockChannel<ContractState> {
        fn configure(ref self: ContractState, prover: ContractAddress) {
            self.prover.write(prover);
        }

        fn set_timed(ref self: ContractState, timed: bool) {
            self.timed.write(timed);
        }

        fn snapshot(self: @ContractState, game_id: felt252) -> (Terms<Config>, u32, felt252, u64) {
            let terms = super::terms_for(
                get_contract_address(), game_id, self.prover.read(), self.timed.read(),
            );
            let anchor = state_hash::<CounterRules>(@super::opening(@terms));
            (terms, 0, anchor, 10)
        }

        fn accept_verified(
            ref self: ContractState,
            game_id: felt252,
            epoch: u32,
            start_hash: felt252,
            end: Envelope<Counter>,
            acks: Span<Signature>,
        ) {
            assert(get_caller_address() == self.prover.read(), 'Wrong callback sender');
            self.accepted.write(state_hash::<CounterRules>(@end));
        }

        fn accepted(self: @ContractState) -> felt252 {
            self.accepted.read()
        }
    }
}

fn setup() -> (ICounterProverDispatcher, IMockChannelDispatcher) {
    let (prover, _) = declare("CounterProver")
        .unwrap()
        .contract_class()
        .deploy(@array![OS_PROGRAM])
        .unwrap_syscall();
    let (channel, _) = declare("MockChannel")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap_syscall();
    let mock = IMockChannelDispatcher { contract_address: channel };
    mock.configure(prover);
    start_cheat_chain_id(prover, 'SN_SEPOLIA');
    start_cheat_block_number(prover, 30);
    (ICounterProverDispatcher { contract_address: prover }, mock)
}

fn add(amount: u8) -> Move<Action> {
    Move::Play(Action { kind: ADD, amount })
}

/// Alice reaches 20 first, every 10 s in a timed game. Returns the batch
/// (each seat's final signature, and the stamps and the referee's attestation
/// in a timed game) and the end state.
fn signed_game(terms: @Terms<Config>) -> (Batch<Action>, Envelope<Counter>) {
    let steps = array![add(3), add(3), add(3), add(3), add(3), add(3), add(2)].span();
    let stamps = if terms.clock.is_some() {
        array![1000, 11000, 21000, 31000, 41000, 51000, 61000].span()
    } else {
        array![].span()
    };
    let context = context_hash::<CounterRules>(terms);
    let mut env = opening(terms);
    let mut finals = no_acks();
    let mut i = 0;
    for step in steps {
        let seat = actor::<CounterRules>(@env, step);
        let message = action_hash::<CounterRules>(context, env.seq, env.transcript, step);
        finals =
            if seat == 0 {
                array![sign(message, PK_A), *finals.at(1)].span()
            } else {
                array![*finals.at(0), sign(message, PK_B)].span()
            };
        let stamp = if stamps.len() == 0 {
            stamps
        } else {
            stamps.slice(i, 1)
        };
        env = apply_steps::<CounterRules>(context, terms, env, (), array![*step].span(), stamp);
        i += 1;
    }
    let attestation = match env.clock {
        Option::Some(clock) => sign(
            stamp_hash::<CounterRules>(context, env.seq, env.transcript, @clock), PK_REF,
        ),
        Option::None => Signature { r: 0, s: 0 },
    };
    (Batch { steps, stamps, signatures: finals, attestation }, env)
}

/// Run `__execute__` as the OS runs a zero-fee virtual invoke.
fn execute_virtual(
    prover: ContractAddress,
    channel: ContractAddress,
    start: Envelope<Counter>,
    batch: Batch<Action>,
) {
    start_cheat_caller_address(prover, 0.try_into().unwrap());
    start_cheat_transaction_version(prover, 3);
    let free = array![
        ResourcesBounds { resource: 'L1_GAS', max_amount: 0, max_price_per_unit: 0 },
        ResourcesBounds { resource: 'L2_GAS', max_amount: 0, max_price_per_unit: 0 },
        ResourcesBounds { resource: 'L1_DATA', max_amount: 0, max_price_per_unit: 0 },
    ];
    cheat_resource_bounds(prover, free.span(), CheatSpan::TargetCalls(1));
    IVirtualCounterDispatcher { contract_address: prover }
        .__execute__(channel, GAME, 0, start, batch);
}

fn transition(
    prover: ContractAddress, channel: ContractAddress, end: @Envelope<Counter>,
) -> Array<felt252> {
    transition_for(prover, channel, end, false)
}

fn transition_for(
    prover: ContractAddress, channel: ContractAddress, end: @Envelope<Counter>, timed: bool,
) -> Array<felt252> {
    let terms = terms_for(channel, GAME, prover, timed);
    payload::<
        CounterRules,
    >(
        get_class_hash(prover).into(),
        prover.into(),
        'SN_SEPOLIA',
        channel.into(),
        GAME,
        context_hash::<CounterRules>(@terms),
        0,
        state_hash::<CounterRules>(@opening(@terms)),
        state_hash::<CounterRules>(end),
    )
}

fn facts(message: felt252) -> ProofFacts {
    ProofFacts {
        proof_version: 'PROOF1',
        program_variant: 'VIRTUAL_SNOS',
        virtual_program_hash: OS_PROGRAM,
        output_version: 'VIRTUAL_SNOS0',
        base_block_number: 20,
        base_block_hash: 456,
        config_hash: 789,
        messages: [message].span(),
    }
}

fn inject(prover: ContractAddress, f: ProofFacts) {
    let mut encoded = array![];
    f.serialize(ref encoded);
    cheat_proof_facts(prover, encoded.span(), CheatSpan::TargetCalls(1));
}

fn no_acks() -> Span<Signature> {
    array![Signature { r: 0, s: 0 }, Signature { r: 0, s: 0 }].span()
}

fn end_state(prover: ContractAddress, channel: ContractAddress) -> Envelope<Counter> {
    let (_, end) = signed_game(@terms(channel, GAME, prover));
    end
}

#[test]
fn virtual_replay_emits_the_message_settle_accepts() {
    let (prover, mock) = setup();
    let terms = terms(mock.contract_address, GAME, prover.contract_address);
    let (batch, end) = signed_game(@terms);

    // Proving path: the OS runs __execute__ as a zero-fee virtual invoke.
    let mut spy = spy_messages_to_l1();
    execute_virtual(prover.contract_address, mock.contract_address, opening(@terms), batch);
    let expected = transition(prover.contract_address, mock.contract_address, @end);
    spy
        .assert_sent(
            @array![
                (
                    prover.contract_address,
                    MessageToL1 { to_address: 0.try_into().unwrap(), payload: expected.clone() },
                ),
            ],
        );

    // Settlement path: facts carrying that message settle the end state.
    inject(
        prover.contract_address,
        facts(message_hash(prover.contract_address.into(), expected.span())),
    );
    prover.settle(mock.contract_address, GAME, 0, end, no_acks());
    assert(mock.accepted() == state_hash::<CounterRules>(@end), 'Wrong callback state');
}

#[test]
#[should_panic(expected: ('Only OS caller', 'ENTRYPOINT_FAILED'))]
fn execute_is_only_for_virtual_invokes() {
    let (prover, mock) = setup();
    let terms = terms(mock.contract_address, GAME, prover.contract_address);
    let (batch, _) = signed_game(@terms);
    let virtual = IVirtualCounterDispatcher { contract_address: prover.contract_address };
    virtual.__execute__(mock.contract_address, GAME, 0, opening(@terms), batch);
}

#[test]
fn timed_replay_emits_the_attested_transition() {
    let (prover, mock) = setup();
    mock.set_timed(true);
    let terms = terms_for(mock.contract_address, GAME, prover.contract_address, true);
    let (batch, end) = signed_game(@terms);
    let mut spy = spy_messages_to_l1();
    execute_virtual(prover.contract_address, mock.contract_address, opening(@terms), batch);
    let expected = transition_for(prover.contract_address, mock.contract_address, @end, true);
    spy
        .assert_sent(
            @array![
                (
                    prover.contract_address,
                    MessageToL1 { to_address: 0.try_into().unwrap(), payload: expected },
                ),
            ],
        );
}

#[test]
#[should_panic(expected: ('Invalid session signature', 'ENTRYPOINT_FAILED'))]
fn timed_replay_needs_the_referee() {
    let (prover, mock) = setup();
    mock.set_timed(true);
    let terms = terms_for(mock.contract_address, GAME, prover.contract_address, true);
    let (batch, end) = signed_game(@terms);
    let context = context_hash::<CounterRules>(@terms);
    let clock = end.clock.unwrap();
    let forged = sign(stamp_hash::<CounterRules>(context, end.seq, end.transcript, @clock), PK_A);
    execute_virtual(
        prover.contract_address,
        mock.contract_address,
        opening(@terms),
        Batch { attestation: forged, ..batch },
    );
}

#[test]
#[should_panic(expected: ('Missing proof facts', 'ENTRYPOINT_FAILED'))]
fn calldata_alone_cannot_settle() {
    let (prover, mock) = setup();
    let end = end_state(prover.contract_address, mock.contract_address);
    prover.settle(mock.contract_address, GAME, 0, end, no_acks());
}

#[test]
#[should_panic(expected: ('Wrong proved transition', 'ENTRYPOINT_FAILED'))]
fn changed_end_state_is_rejected() {
    let (prover, mock) = setup();
    let end = end_state(prover.contract_address, mock.contract_address);
    let expected = transition(prover.contract_address, mock.contract_address, @end);
    inject(
        prover.contract_address,
        facts(message_hash(prover.contract_address.into(), expected.span())),
    );
    let mut changed = end;
    changed.outcome.winner = 2;
    prover.settle(mock.contract_address, GAME, 0, changed, no_acks());
}

#[test]
#[should_panic(expected: ('Wrong proved transition', 'ENTRYPOINT_FAILED'))]
fn proof_for_another_game_is_rejected() {
    let (prover, mock) = setup();
    let end = end_state(prover.contract_address, mock.contract_address);
    let expected = transition(prover.contract_address, mock.contract_address, @end);
    inject(
        prover.contract_address,
        facts(message_hash(prover.contract_address.into(), expected.span())),
    );
    prover.settle(mock.contract_address, GAME + 1, 0, end, no_acks());
}

#[test]
#[should_panic(expected: ('Stale proof epoch', 'ENTRYPOINT_FAILED'))]
fn stale_epoch_is_rejected() {
    let (prover, mock) = setup();
    let end = end_state(prover.contract_address, mock.contract_address);
    prover.settle(mock.contract_address, GAME, 1, end, no_acks());
}

#[test]
fn large_path_proof_is_accepted() {
    let (prover, mock) = setup();
    let end = end_state(prover.contract_address, mock.contract_address);
    let expected = transition(prover.contract_address, mock.contract_address, @end);
    let mut f = facts(message_hash(prover.contract_address.into(), expected.span()));
    f.proof_version = 'PROOF2';
    inject(prover.contract_address, f);
    prover.settle(mock.contract_address, GAME, 0, end, no_acks());
    assert(mock.accepted() == state_hash::<CounterRules>(@end), 'Wrong callback state');
}

#[test]
fn deployment_pins_the_os_program() {
    let (prover, _) = setup();
    assert(prover.os_program() == OS_PROGRAM, 'Wrong pinned OS program');
}

#[test]
fn zero_os_program_cannot_be_pinned() {
    let class = declare("CounterProver").unwrap().contract_class();
    assert(class.deploy(@array![0]).is_err(), 'Zero OS program accepted');
}

fn check(f: ProofFacts) {
    let mut data = array![];
    f.serialize(ref data);
    check_facts(data.span(), 42, OS_PROGRAM, 30, 10);
}

#[test]
#[should_panic(expected: 'Wrong proof version')]
fn old_proof_schema_is_rejected() {
    let mut f = facts(42);
    f.proof_version = 'PROOF0';
    check(f);
}

#[test]
#[should_panic(expected: 'Wrong program variant')]
fn another_program_variant_is_rejected() {
    let mut f = facts(42);
    f.program_variant = 0;
    check(f);
}

#[test]
#[should_panic(expected: 'Wrong OS program')]
fn proof_of_another_os_program_is_rejected() {
    let mut f = facts(42);
    f.virtual_program_hash = OS_PROGRAM + 1;
    check(f);
}

#[test]
#[should_panic(expected: 'Wrong output version')]
fn another_output_schema_is_rejected() {
    let mut f = facts(42);
    f.output_version = 0;
    check(f);
}

#[test]
#[should_panic(expected: 'Proof predates anchor')]
fn stale_base_is_rejected() {
    let mut f = facts(42);
    f.base_block_number = 9;
    check(f);
}

#[test]
#[should_panic(expected: 'Invalid base block')]
fn future_base_is_rejected() {
    let mut f = facts(42);
    f.base_block_number = 30;
    check(f);
}

#[test]
#[should_panic(expected: 'Expired proof')]
fn expired_fact_is_rejected() {
    let mut data = array![];
    facts(42).serialize(ref data);
    check_facts(data.span(), 42, OS_PROGRAM, 4021, 10);
}

#[test]
#[should_panic(expected: 'Wrong proved transition')]
fn extra_messages_are_rejected() {
    let mut f = facts(42);
    f.messages = [42, 42].span();
    check(f);
}

#[test]
#[should_panic(expected: 'Trailing proof facts')]
fn trailing_facts_are_rejected() {
    let mut data = array![];
    facts(42).serialize(ref data);
    data.append(1);
    check_facts(data.span(), 42, OS_PROGRAM, 30, 10);
}

#[test]
#[should_panic(expected: 'Malformed proof facts')]
fn malformed_fact_is_rejected() {
    check_facts([1].span(), 42, OS_PROGRAM, 30, 10);
}
