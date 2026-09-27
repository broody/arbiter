import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hash } from 'starknet';
import { POSEIDON_BACKEND, poseidon } from '../src/index.mjs';

const PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const random = () => BigInt(`0x${randomBytes(32).toString('hex')}`) % PRIME;
const reference = values => BigInt(hash.computePoseidonHashOnElements(values));

test('Poseidon runs in WebAssembly under Node', () => {
  assert.equal(POSEIDON_BACKEND, 'wasm');
});

test('WebAssembly Poseidon matches starknet.js, across the buffer boundary', () => {
  for (let n = 0; n <= 140; n++) {
    const values = Array.from({ length: n }, random);
    assert.equal(poseidon(values), reference(values), `${n} felts`);
  }
});

test('WebAssembly Poseidon matches starknet.js at the edges of the field', () => {
  for (const values of [[0n], [PRIME - 1n], [PRIME - 1n, PRIME - 1n, 0n], Array(64).fill(PRIME - 1n), Array(65).fill(1n)]) {
    assert.equal(poseidon(values), reference(values));
  }
  assert.throws(() => poseidon([PRIME]), /Invalid felt/);
});
