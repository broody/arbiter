//! Poseidon (`poseidon_hash_many`, as Cairo's `poseidon_hash_span`) for the JS
//! SDK. JS writes felts as 32-byte little-endian values into `buffer()`, up to
//! `capacity()` at a time, absorbs them, and reads the digest back from the
//! buffer's start: `hash(n)` for one call, or `begin`, `absorb(n)` and `finish`
//! for longer inputs.
#![no_std]

use core::ptr::addr_of_mut;
use starknet_crypto::{Felt, PoseidonHasher};

const CAPACITY: usize = 64;
static mut BUFFER: [u8; 32 * CAPACITY] = [0; 32 * CAPACITY];
static mut HASHER: Option<PoseidonHasher> = None;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Poseidon never allocates; a dependency only links `alloc`. Any allocation
/// fails, and traps, rather than growing memory unnoticed.
struct NoAlloc;

unsafe impl core::alloc::GlobalAlloc for NoAlloc {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }
    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

#[global_allocator]
static ALLOCATOR: NoAlloc = NoAlloc;

// SAFETY (both): WebAssembly here is single-threaded, and no reference outlives
// the exported call that takes it.
fn buffer_bytes() -> &'static mut [u8; 32 * CAPACITY] {
    unsafe { &mut *addr_of_mut!(BUFFER) }
}

fn hasher() -> &'static mut Option<PoseidonHasher> {
    unsafe { &mut *addr_of_mut!(HASHER) }
}

fn felt(i: usize) -> Felt {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&buffer_bytes()[i * 32..(i + 1) * 32]);
    Felt::from_bytes_le(&bytes)
}

#[no_mangle]
pub extern "C" fn buffer() -> *mut u8 {
    addr_of_mut!(BUFFER) as *mut u8
}

#[no_mangle]
pub extern "C" fn capacity() -> u32 {
    CAPACITY as u32
}

#[no_mangle]
pub extern "C" fn begin() {
    *hasher() = Some(PoseidonHasher::new());
}

/// Absorb the first `n` felts of the buffer.
#[no_mangle]
pub extern "C" fn absorb(n: u32) {
    let n = (n as usize).min(CAPACITY);
    let hasher = hasher().as_mut().expect("begin first");
    for i in 0..n {
        hasher.update(felt(i));
    }
}

/// Finish the hash and write the digest to the buffer's first 32 bytes.
#[no_mangle]
pub extern "C" fn finish() {
    let digest = hasher().take().expect("begin first").finalize().to_bytes_le();
    buffer_bytes()[..32].copy_from_slice(&digest);
}

/// Hash the first `n` felts of the buffer (n <= capacity) in one call.
#[no_mangle]
pub extern "C" fn hash(n: u32) {
    begin();
    absorb(n);
    finish();
}
