#!/usr/bin/env bash
# Run the PROOF1 backend (built by build.sh) and the gateway in front of it.
#
#   prover/run.sh CONFIG_JSON
#
# The backend listens on backend_url (keep it on localhost) with the gateway's
# concurrency and memory mode, against the same RPC node and chain. Stopping this
# script stops both.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
config="${1:?usage: prover/run.sh CONFIG_JSON}"
BUILD_DIR="${REFEREE_PROVER_BUILD:-$HOME/.cache/referee-prover}"
get() { node -e "const c=require('$(realpath "$config")');console.log(c.$1??'')"; }
backend="$(get backend_url)"
port="${backend##*:}"; port="${port%%/*}"
[ -x "$BUILD_DIR/bin/starknet_transaction_prover" ] || { echo "Build the backend first: prover/build.sh" >&2; exit 1; }
memory_env=$(node --input-type=module -e "
import { MEMORY_MODES } from '$here/server.mjs';
const mode = process.argv[1];
if (!Object.hasOwn(MEMORY_MODES, mode)) { console.error('memory must be one of ' + Object.keys(MEMORY_MODES).join(', ')); process.exit(1); }
console.log(Object.entries(MEMORY_MODES[mode]).map(([k, v]) => k + '=' + v).join(' '));" "$(get "memory??'standard'")") || exit 1
read -ra memory_env <<<"$memory_env"

RPC_URL="$(get rpc_url)" CHAIN_ID="$(get chain_id)" PROVER_IP=127.0.0.1 PROVER_PORT="$port" \
MAX_CONCURRENT_REQUESTS="$(get 'max_concurrent??1')" PREFETCH_STATE="$(get 'prefetch_state??true')" \
CARGO_TOOLS_ROOT="$BUILD_DIR/tools" \
RUST_LOG="${RUST_LOG:-warn,starknet_transaction_prover=info,privacy_prove=info}" \
  env "${memory_env[@]}" "$BUILD_DIR/bin/starknet_transaction_prover" --no-cors &
backend_pid=$!
trap 'kill $backend_pid 2>/dev/null; wait $backend_pid 2>/dev/null' EXIT

for _ in $(seq 1 120); do
  curl -sf -X POST "$backend" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"starknet_specVersion","params":[]}' >/dev/null && break
  kill -0 $backend_pid 2>/dev/null || { echo "backend exited" >&2; exit 1; }
  sleep 1
done
node "$here/server.mjs" "$config"
