#!/usr/bin/env bash
# Build the PROOF1 backend: StarkWare's starknet_transaction_prover (the service
# behind the hosted Sepolia prover) at the sequencer revision pinned in pins.json,
# with in-process Stwo proving and arbiter's patches (patches/: the memory modes,
# allocator trim and PIE dump in the README, each off unless the backend's
# environment turns it on). Output:
# $BUILD_DIR/bin/starknet_transaction_prover, $BUILD_DIR/bin/prove_pie (proves a
# PIE the backend dumped with PROVER_PIE_DUMP, offline; see README), the Sierra
# compiler under $BUILD_DIR/tools, and $BUILD_DIR/build.json.
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
DEPS=$(pin 'Object.keys(p.patches.dependencies).join(" ")')
BUILD_DIR="${ARBITER_PROVER_BUILD:-$HOME/.cache/arbiter-prover}"
SRC="$BUILD_DIR/sequencer"
[ -n "${CAIRO_LANG_BIN:-}" ] && export PATH="$CAIRO_LANG_BIN:$PATH"

command -v cairo-compile >/dev/null || { echo "cairo-compile not found: install cairo-lang==$CAIRO_LANG or set CAIRO_LANG_BIN" >&2; exit 1; }
cairo-compile --version 2>&1 | grep -q "$CAIRO_LANG" || { echo "cairo-compile is not cairo-lang $CAIRO_LANG: $(cairo-compile --version 2>&1)" >&2; exit 1; }
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal

# Put DIR at REPOSITORY@REVISION with no local changes (ignored build output such
# as target/ survives), then apply PATCH if given.
checkout() {
  local dir=$1 repo=$2 rev=$3 patch=${4:-}
  [ -d "$dir/.git" ] || git init -q "$dir"
  git -C "$dir" cat-file -e "$rev^{commit}" 2>/dev/null || git -C "$dir" fetch -q --depth 1 "$repo" "$rev"
  git -C "$dir" -c advice.detachedHead=false checkout -q --force "$rev"
  git -C "$dir" clean -fdq
  [ "$(git -C "$dir" rev-parse HEAD)" = "$rev" ] || { echo "$dir is not at $rev" >&2; exit 1; }
  [ -z "$patch" ] || git -C "$dir" apply "$patch"
}

mkdir -p "$BUILD_DIR/bin"
[ -d "$SRC/.git" ] || git clone --no-checkout "${SEQUENCER_SOURCE:-$REPO}" "$SRC"
checkout "$SRC" "$REPO" "$REV"
# Each patched dependency must be the revision the sequencer already locks, so the
# patches change storage, not versions. The [patch] section (sequencer.patch)
# points Cargo at these copies, which sit next to the sequencer.
for dep in $DEPS; do
  repo=$(pin "p.patches.dependencies['$dep'].repository"); rev=$(pin "p.patches.dependencies['$dep'].revision")
  grep -q "\"git+${repo%.git}?[^\"#]*#$rev\"" "$SRC/Cargo.lock" || { echo "the sequencer does not lock $dep at $rev" >&2; exit 1; }
  checkout "$BUILD_DIR/$dep" "$repo" "$rev" "$here/patches/$dep.patch"
done
git -C "$SRC" apply "$here/patches/sequencer.patch"

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
install -m 0755 target/release/prove_pie "$BUILD_DIR/bin/prove_pie"

# The service compiles fetched Sierra classes to CASM with this binary at runtime,
# found under $CARGO_TOOLS_ROOT.
CARGO_TOOLS_ROOT="$BUILD_DIR/tools" bash scripts/install_compiler_binaries.sh --sierra >/dev/null

node -e "
const fs=require('fs'),crypto=require('crypto'),path=require('path');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const bin='$BUILD_DIR/bin/starknet_transaction_prover',dir='$here/patches';
const patches=Object.fromEntries(fs.readdirSync(dir).sort().map(f=>[f,sha(fs.readFileSync(path.join(dir,f)))]));
fs.writeFileSync('$BUILD_DIR/build.json',JSON.stringify({
  sequencer:'$REPO@$REV',toolchain:'$TOOLCHAIN',cairo_lang:'$CAIRO_LANG',target_cpu:process.env.TARGET_CPU||null,
  patches,binary_sha256:sha(fs.readFileSync(bin)),built_at:new Date().toISOString()},null,2)+'\n');"
echo "built $BUILD_DIR/bin/starknet_transaction_prover (tools in $BUILD_DIR/tools)"
