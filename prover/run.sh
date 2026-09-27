#!/usr/bin/env bash
# Run the prover gateway. It starts the PROOF1 backend (built by build.sh) as
# isolated workers: max_concurrent backends, one job each, each in its own
# cgroup (workers.mjs). Here the gateway runs in a systemd user scope with
# Delegate=yes, which gives it the cgroup subtree its workers need; deployments
# use deploy/referee-prover.service or deploy/Dockerfile instead.
#
#   prover/run.sh CONFIG_JSON
#
# Stopping this script stops the gateway and its workers. REFEREE_PROVER_BUILD
# selects the build (default ~/.cache/referee-prover) unless the config's
# build_dir does.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
config="$(realpath "${1:?usage: prover/run.sh CONFIG_JSON}")"
# Only cgroup workers under "self" need the delegated scope.
delegate=$(node -e "const c=require('$config'), w=c.workers??{};
console.log(!c.backend_url && (w.sandbox??'cgroup')==='cgroup' && (w.cgroup_root??'self')==='self')")
if [ "$delegate" = true ]; then
  command -v systemd-run >/dev/null || { echo "cgroup workers need systemd-run (or set workers.cgroup_root to a delegated cgroup)" >&2; exit 1; }
  exec systemd-run --user --scope --quiet -p Delegate=yes node "$here/server.mjs" "$config"
fi
exec node "$here/server.mjs" "$config"
