#!/usr/bin/env bash
# Run the cgroup worker tests (cgroup.test.mjs) in a systemd user scope with
# Delegate=yes, which gives them the delegated cgroup subtree workers need.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec systemd-run --user --scope --quiet -p Delegate=yes -p MemorySwapMax=0 \
  env ARBITER_CGROUP_TEST=1 node --test --experimental-test-isolation=none prover/test/cgroup.test.mjs
