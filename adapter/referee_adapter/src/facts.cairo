/// Maximum age, in blocks, of a proof's base block at settlement.
pub const MAX_PROOF_AGE: u64 = 4000;

#[derive(Copy, Drop, Serde)]
pub struct ProofFacts {
    pub proof_version: felt252,
    pub program_variant: felt252,
    pub virtual_program_hash: felt252,
    pub output_version: felt252,
    pub base_block_number: u64,
    pub base_block_hash: felt252,
    pub config_hash: felt252,
    pub messages: Span<felt252>,
}

/// Check network-verified proof facts. PROOF1 is the small path and PROOF2 the
/// large path added in Starknet v0.14.4; both attest the same virtual-OS
/// facts. The proof must be based on a block at or after the one that set the
/// state it starts from (the channel's anchor or candidate), be at most
/// `MAX_PROOF_AGE` blocks old, and carry exactly `expected`.
pub fn check_facts(
    mut encoded: Span<felt252>, expected: felt252, os_program: felt252, current: u64, anchor: u64,
) {
    assert(!encoded.is_empty(), 'Missing proof facts');
    let facts: ProofFacts = Serde::deserialize(ref encoded).expect('Malformed proof facts');
    assert(encoded.is_empty(), 'Trailing proof facts');
    assert(
        facts.proof_version == 'PROOF1' || facts.proof_version == 'PROOF2', 'Wrong proof version',
    );
    assert(facts.program_variant == 'VIRTUAL_SNOS', 'Wrong program variant');
    assert(facts.virtual_program_hash == os_program, 'Wrong OS program');
    assert(facts.output_version == 'VIRTUAL_SNOS0', 'Wrong output version');
    assert(facts.base_block_number >= anchor, 'Proof predates anchor');
    assert(facts.base_block_number < current, 'Invalid base block');
    assert(current - facts.base_block_number <= MAX_PROOF_AGE, 'Expired proof');
    assert(facts.messages == [expected].span(), 'Wrong proved transition');
}
