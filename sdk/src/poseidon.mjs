// Poseidon over the Stark field (Cairo's `poseidon_hash_span`) in WebAssembly:
// starknet-crypto's PoseidonHasher, built from sdk/poseidon into
// ./poseidon-wasm.mjs. About ten times faster than starknet.js's JavaScript,
// which it falls back to where WebAssembly cannot run (e.g. a page whose
// Content-Security-Policy forbids it).
import { hash } from 'starknet';
import { POSEIDON_WASM } from './poseidon-wasm.mjs';

const LIMB = (1n << 64n) - 1n;

async function load() {
  try {
    const bytes = Uint8Array.from(atob(POSEIDON_WASM), c => c.charCodeAt(0));
    return (await WebAssembly.instantiate(bytes)).instance.exports;
  } catch {
    return null;
  }
}
const wasm = globalThis.WebAssembly ? await load() : null;

/** Which implementation `poseidonHashMany` runs: 'wasm' or 'js'. */
export const POSEIDON_BACKEND = wasm ? 'wasm' : 'js';

// The module's buffer holds `capacity` felts as 32-byte little-endian values.
function wasmHash() {
  const capacity = wasm.capacity();
  let view = null;
  const buffer = () => {
    if (view?.buffer !== wasm.memory.buffer) view = new DataView(wasm.memory.buffer, wasm.buffer(), 32 * capacity);
    return view;
  };
  const write = (v, values) => values.forEach((x, i) => {
    for (let limb = 0; limb < 4; limb++) v.setBigUint64(32 * i + 8 * limb, (x >> BigInt(64 * limb)) & LIMB, true);
  });
  const read = v => {
    let x = 0n;
    for (let limb = 3; limb >= 0; limb--) x = (x << 64n) | v.getBigUint64(8 * limb, true);
    return x;
  };
  return values => {
    const v = buffer();
    if (values.length <= capacity) {
      write(v, values);
      wasm.hash(values.length);
    } else {
      wasm.begin();
      for (let at = 0; at < values.length; at += capacity) {
        const chunk = values.slice(at, at + capacity);
        write(v, chunk);
        wasm.absorb(chunk.length);
      }
      wasm.finish();
    }
    return read(v);
  };
}

/** Poseidon of felts: BigInts already checked to be below the field prime. */
export const poseidonHashMany = wasm
  ? wasmHash()
  : values => BigInt(hash.computePoseidonHashOnElements(values));
