#!/usr/bin/env bash
# Regenerate fixtures, fail if they changed, and test the pure crates on both
# Cairo toolchains (2.13 for Dojo, 2.18 for the native proof adapter), then the
# Dojo binding on 2.13 and the proof adapter on 2.18.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd sdk && node scripts/gen-counter-fixtures.mjs)
scarb fmt
if git rev-parse -q --verify HEAD >/dev/null; then
  git diff --exit-code HEAD -- examples/counter/src/fixtures.cairo || { echo "fixtures changed; commit them" >&2; exit 1; }
fi
for version in 2.13.1 2.18.0; do
  echo "== scarb $version"
  ASDF_SCARB_VERSION=$version scarb test
done
# Dojo 1.8 is pinned to Cairo 2.13.
echo "== dojo (scarb 2.13.1)"
(cd dojo && scarb fmt --check && ASDF_SCARB_VERSION=2.13.1 scarb test)
# The proof adapter needs Cairo 2.18 and Starknet Foundry 0.63 (asdf shim first:
# an older global snforge may shadow it on PATH).
echo "== adapter (scarb 2.18.0, snforge 0.63.0)"
SNFORGE="${SNFORGE:-$(command -v "$HOME/.asdf/shims/snforge" || command -v snforge)}"
(cd adapter && ASDF_SCARB_VERSION=2.18.0 scarb fmt --check \
  && cd examples/counter \
  && ASDF_SCARB_VERSION=2.18.0 ASDF_STARKNET_FOUNDRY_VERSION=0.63.0 "$SNFORGE" test)
