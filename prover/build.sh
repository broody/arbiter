#!/usr/bin/env bash
# Build the PROOF1 backend: StarkWare's starknet_transaction_prover (the service
# behind the hosted Sepolia prover) at the sequencer revision pinned in pins.json,
# with in-process Stwo proving. Output: $BUILD_DIR/bin/starknet_transaction_prover,
# the Sierra compiler under $BUILD_DIR/tools, and $BUILD_DIR/build.json.
#
#   prover/build.sh
#
# Environment:
#   REFEREE_PROVER_BUILD  build directory (default ~/.cache/referee-prover)
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
BUILD_DIR="${REFEREE_PROVER_BUILD:-$HOME/.cache/referee-prover}"
SRC="$BUILD_DIR/sequencer"
[ -n "${CAIRO_LANG_BIN:-}" ] && export PATH="$CAIRO_LANG_BIN:$PATH"

command -v cairo-compile >/dev/null || { echo "cairo-compile not found: install cairo-lang==$CAIRO_LANG or set CAIRO_LANG_BIN" >&2; exit 1; }
cairo-compile --version 2>&1 | grep -q "$CAIRO_LANG" || { echo "cairo-compile is not cairo-lang $CAIRO_LANG: $(cairo-compile --version 2>&1)" >&2; exit 1; }
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal

mkdir -p "$BUILD_DIR/bin"
if [ ! -d "$SRC/.git" ]; then
  git clone --no-checkout "${SEQUENCER_SOURCE:-$REPO}" "$SRC"
fi
git -C "$SRC" cat-file -e "$REV^{commit}" 2>/dev/null || git -C "$SRC" fetch "$REPO" "$REV"
git -C "$SRC" -c advice.detachedHead=false checkout -q --force "$REV"
[ "$(git -C "$SRC" rev-parse HEAD)" = "$REV" ] || { echo "sequencer is not at $REV" >&2; exit 1; }

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

# The service compiles fetched Sierra classes to CASM with this binary at runtime,
# found under $CARGO_TOOLS_ROOT.
CARGO_TOOLS_ROOT="$BUILD_DIR/tools" bash scripts/install_compiler_binaries.sh --sierra >/dev/null

node -e "
const fs=require('fs'),crypto=require('crypto');
const bin='$BUILD_DIR/bin/starknet_transaction_prover';
fs.writeFileSync('$BUILD_DIR/build.json',JSON.stringify({
  sequencer:'$REPO@$REV',toolchain:'$TOOLCHAIN',cairo_lang:'$CAIRO_LANG',target_cpu:process.env.TARGET_CPU||null,
  binary_sha256:crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex'),built_at:new Date().toISOString()},null,2)+'\n');"
echo "built $BUILD_DIR/bin/starknet_transaction_prover (tools in $BUILD_DIR/tools)"
