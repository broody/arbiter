#!/usr/bin/env bash
# Regenerate fixtures, fail if they changed, and test on both Cairo toolchains:
# 2.13 (Dojo) and 2.18 (native proof adapter).
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
