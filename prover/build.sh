#!/usr/bin/env bash
# Build the PROOF2 backend: StarkWare's starknet_transaction_prover (the service
# behind the hosted prover) at the sequencer revision pinned in pins.json, with
# in-process Stwo proving, and with the prover crates it takes from
# starkware-libs/proving swapped for the pinned branch of them
# (patches/sequencer.patch: a Cargo [patch] and its lock; the README's Memory).
# Output: $BUILD_DIR/bin/starknet_transaction_prover, the Sierra compiler under
# $BUILD_DIR/tools, and $BUILD_DIR/build.json.
#
#   prover/build.sh
#
# Environment:
#   ARBITER_PROVER_BUILD  build directory (default ~/.cache/arbiter-prover)
#   SEQUENCER_SOURCE      clone source (default: the pinned repository; a local
#                         clone of it saves the download)
#   CAIRO_LANG_BIN        directory holding cairo-compile from cairo-lang 0.14.3a3,
#                         if it is not already on PATH (the OS compiles at build time)
#   TARGET_CPU            e.g. native (about 1.7x faster proofs, ties the binary to this CPU)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pin() { node -e "const p=require('$here/pins.json');console.log($1)"; }
REPO=$(pin 'p.sequencer.repository'); REV=$(pin 'p.sequencer.revision')
TOOLCHAIN=$(pin 'p.toolchain'); CAIRO_LANG=$(pin 'p.cairo_lang')
PROVING_REPO=$(pin 'p.proving.repository'); PROVING_REV=$(pin 'p.proving.revision')
BUILD_DIR="${ARBITER_PROVER_BUILD:-$HOME/.cache/arbiter-prover}"
SRC="$BUILD_DIR/sequencer"
[ -n "${CAIRO_LANG_BIN:-}" ] && export PATH="$CAIRO_LANG_BIN:$PATH"

command -v cairo-compile >/dev/null || { echo "cairo-compile not found: install cairo-lang==$CAIRO_LANG or set CAIRO_LANG_BIN" >&2; exit 1; }
cairo-compile --version 2>&1 | grep -q "$CAIRO_LANG" || { echo "cairo-compile is not cairo-lang $CAIRO_LANG: $(cairo-compile --version 2>&1)" >&2; exit 1; }
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal

mkdir -p "$BUILD_DIR/bin"
# The sequencer at its pinned revision with no local changes (ignored build output
# such as target/ survives), then the patch.
[ -d "$SRC/.git" ] || git clone --no-checkout "${SEQUENCER_SOURCE:-$REPO}" "$SRC"
git -C "$SRC" cat-file -e "$REV^{commit}" 2>/dev/null || git -C "$SRC" fetch -q --depth 1 "$REPO" "$REV"
git -C "$SRC" -c advice.detachedHead=false checkout -q --force "$REV"
git -C "$SRC" clean -fdq
[ "$(git -C "$SRC" rev-parse HEAD)" = "$REV" ] || { echo "$SRC is not at $REV" >&2; exit 1; }
git -C "$SRC" apply "$here/patches/sequencer.patch"
# The patch's lock must take the prover crates from the pinned branch, and only from it.
grep -q "\"git+${PROVING_REPO%.git}?rev=$PROVING_REV#" "$SRC/Cargo.lock" || { echo "sequencer.patch does not lock $PROVING_REPO at $PROVING_REV" >&2; exit 1; }
! grep -q '"git+https://github.com/starkware-libs/proving?' "$SRC/Cargo.lock" || { echo "sequencer.patch leaves crates from starkware-libs/proving" >&2; exit 1; }

cd "$SRC"
# The workspace config wraps rustc in sccache; build without it, as upstream's Dockerfile does.
export RUSTC_WRAPPER=""
cpu_flags=()
if [ -n "${TARGET_CPU:-}" ]; then
  # Optimize the binary only; build scripts and proc macros stay portable.
  cpu_flags=(CARGO_UNSTABLE_PROFILE_RUSTFLAGS=true "CARGO_PROFILE_RELEASE_RUSTFLAGS=-C target-cpu=$TARGET_CPU"
    CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_RUSTFLAGS=)
fi
env "${cpu_flags[@]}" cargo +"$TOOLCHAIN" build --release --locked -p starknet_transaction_prover --features stwo_proving
install -m 0755 target/release/starknet_transaction_prover "$BUILD_DIR/bin/starknet_transaction_prover"
rm -f "$BUILD_DIR/bin/prove_pie"  # a PROOF1 build's

# The service compiles fetched Sierra classes to CASM with this binary at runtime,
# found under $CARGO_TOOLS_ROOT.
CARGO_TOOLS_ROOT="$BUILD_DIR/tools" bash scripts/install_compiler_binaries.sh --sierra >/dev/null

node -e "
const fs=require('fs'),crypto=require('crypto'),path=require('path');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const bin='$BUILD_DIR/bin/starknet_transaction_prover',dir='$here/patches';
const patches=Object.fromEntries(fs.readdirSync(dir).sort().map(f=>[f,sha(fs.readFileSync(path.join(dir,f)))]));
fs.writeFileSync('$BUILD_DIR/build.json',JSON.stringify({
  sequencer:'$REPO@$REV',proving:'$PROVING_REPO@$PROVING_REV',toolchain:'$TOOLCHAIN',cairo_lang:'$CAIRO_LANG',target_cpu:process.env.TARGET_CPU||null,
  patches,binary_sha256:sha(fs.readFileSync(bin)),built_at:new Date().toISOString()},null,2)+'\n');"
echo "built $BUILD_DIR/bin/starknet_transaction_prover (tools in $BUILD_DIR/tools)"
