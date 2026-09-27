#!/usr/bin/env bash
# End-to-end keeper check with real transactions: start a Katana, deploy the
# counter Dojo world, then run keeper/katana.mjs against it.
#
# Tested with katana 1.7.1 and sozo 1.8.0 (sozo 1.8.5 fails to deploy the world
# on katana 1.7.1 with InsufficientResourcesForValidate). Override with
# KATANA_VERSION and SOZO_VERSION; KATANA_PORT defaults to 5059.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${KATANA_PORT:-5059}
RPC="http://localhost:$PORT"
call() { curl -sf -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC"; }
if call starknet_chainId >/dev/null; then echo "Something already listens on port $PORT; set KATANA_PORT" >&2; exit 1; fi

manifest=dojo/manifest_dev.json
[ -e "$manifest" ] && keep_manifest=1 || keep_manifest=0
log=$(mktemp)
ASDF_KATANA_VERSION=${KATANA_VERSION:-1.7.1} katana --dev --dev.seed 0 --dev.accounts 4 --http.port "$PORT" >"$log" 2>&1 &
katana=$!
cleanup() { kill "$katana" 2>/dev/null || true; rm -f "$log"; [ "$keep_manifest" = 1 ] || rm -f "$manifest"; }
trap cleanup EXIT
for _ in $(seq 60); do call starknet_chainId >/dev/null && break; sleep 0.5; done
call starknet_chainId >/dev/null || { cat "$log" >&2; exit 1; }

read -r address key < <(call dev_predeployedAccounts | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [a]=JSON.parse(s).result;console.log(a.address,a.privateKey)})')
(cd dojo && export ASDF_SOZO_VERSION=${SOZO_VERSION:-1.8.0} \
  && sozo build -p referee_counter_dojo >/dev/null \
  && sozo migrate --rpc-url "$RPC" --account-address "$address" --private-key "$key" >/dev/null)
channel=$(node -e 'console.log(require("./dojo/manifest_dev.json").contracts.find(c => c.tag === "counter-channel").address)')
node keeper/katana.mjs "$RPC" "$channel"
