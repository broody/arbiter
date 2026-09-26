//! Test-only helpers. `sign` computes STARK-curve ECDSA inside Cairo so tests
//! can sign messages that depend on runtime values (deployed addresses, chain
//! id). Never call these from a contract: they take private keys.
use core::ec::{EcPoint, EcPointTrait, NonZeroEcPoint, stark_curve};
use core::math::{u256_inv_mod, u256_mul_mod_n};
use core::poseidon::poseidon_hash_span;
use referee::{Signature, rng_next};

fn generator() -> EcPoint {
    EcPointTrait::new(stark_curve::GEN_X, stark_curve::GEN_Y).unwrap()
}

pub fn public_key(private_key: felt252) -> felt252 {
    let point: NonZeroEcPoint = generator().mul(private_key).try_into().unwrap();
    point.x()
}

/// ECDSA over the STARK curve: r = (kG).x, s = k⁻¹(z + r·d) mod n, with a
/// deterministic nonce derived from the key and message.
pub fn sign(message: felt252, private_key: felt252) -> Signature {
    let order: u256 = stark_curve::ORDER.into();
    let n: NonZero<u256> = order.try_into().unwrap();
    let z: u256 = message.into();
    let d: u256 = private_key.into();
    let mut attempt: felt252 = 0;
    loop {
        let nonce: u256 = poseidon_hash_span(
            array!['REFEREE_TEST_NONCE', private_key, message, attempt].span(),
        )
            .into();
        attempt += 1;
        let k = nonce % order;
        if k == 0 {
            continue;
        }
        let k_felt: felt252 = k.try_into().unwrap();
        let point: NonZeroEcPoint = match generator().mul(k_felt).try_into() {
            Option::Some(p) => p,
            Option::None => { continue; },
        };
        let r = point.x();
        let r_u256: u256 = r.into();
        // Referee's verifier requires r < 2^251.
        if r_u256 >= 0x800000000000000000000000000000000000000000000000000000000000000 {
            continue;
        }
        let r_mod = r_u256 % order;
        if r_mod == 0 {
            continue;
        }
        let k_inv: u256 = u256_inv_mod(k, n).unwrap().into();
        let sum = (z + u256_mul_mod_n(r_mod, d, n)) % order;
        let s = u256_mul_mod_n(sum, k_inv, n);
        if s == 0 {
            continue;
        }
        break Signature { r, s: s.try_into().unwrap() };
    }
}

/// Hash-chain value at `index` from `seed` (the committed tip is at the chain length).
pub fn chain_value(seed: felt252, index: u32) -> felt252 {
    let mut value = seed;
    let mut i = 0;
    while i < index {
        value = rng_next(value);
        i += 1;
    }
    value
}

#[cfg(test)]
mod tests {
    use referee::verify;
    use super::{public_key, sign};

    #[test]
    fn signatures_verify() {
        let key = 0x1a2b3c;
        let message = 0x123456789abcdef;
        verify(public_key(key), message, sign(message, key));
    }

    #[test]
    fn public_key_matches_starknet_js() {
        // From the JS SDK fixtures: publicKey(0x1a2b3c).
        assert_eq!(
            public_key(0x1a2b3c), 0x2df1db011696a4657ca38f92c517c1bfb36e567f0a401334d5f793a0bd8a687,
        );
    }

    #[test]
    #[should_panic(expected: 'Invalid session signature')]
    fn wrong_key_rejected() {
        let message = 0x42;
        verify(public_key(0x1a2b3c), message, sign(message, 0x4d5e6f));
    }
}
