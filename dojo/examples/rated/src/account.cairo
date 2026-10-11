//! A test wallet: an account contract that checks STARK-curve signatures over
//! its public key (`is_valid_signature`, SNIP-6), as the channel checks a
//! seat's signed terms.
#[starknet::contract]
pub mod TestAccount {
    use core::ecdsa::check_ecdsa_signature;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        public_key: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: felt252) {
        self.public_key.write(public_key);
    }

    #[external(v0)]
    fn is_valid_signature(
        self: @ContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252 {
        if signature.len() == 2
            && check_ecdsa_signature(
                hash, self.public_key.read(), *signature.at(0), *signature.at(1),
            ) {
            'VALID'
        } else {
            0
        }
    }
}
