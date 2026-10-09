#!/usr/bin/env bash
# Measure the backend under a client's load: start it in its own cgroup (a
# systemd user scope with swap off and an optional memory cap), run the client,
# then report the cgroup's peak memory and the backend's own OS-run and proof
# times. Each call starts a fresh backend, so the peak covers exactly this run.
#
#   prover/measure.sh RPC_URL -- CLIENT_COMMAND [ARG ...]
#
# The client finds the backend at $BACKEND_URL and its cgroup directory at
# $MEASURE_CGROUP (to sample memory.current between requests). Its output passes
# through, and a final JSON line summarizes the run. For example, one proof of a
# job from Surround's offchain/server/tools/os-job.mjs:
#
#   prover/measure.sh http://127.0.0.1:9545/rpc/v0_10 -- sh -c 'curl -s $BACKEND_URL \
#     -H "Content-Type: application/json" -d @request.json'
#
# Environment:
#   ARBITER_PROVER_BUILD     the build to measure (default ~/.cache/arbiter-prover)
#   CHAIN_ID                 default SN_SEPOLIA
#   MEASURE_MEMORY_MAX       cgroup memory cap, e.g. 24G (default none)
#   MEASURE_PORT             backend port (default 3050)
#   MEASURE_LOG              backend log (default $ARBITER_PROVER_BUILD/measure/<unit>.log)
#   MAX_CONCURRENT_REQUESTS  backend concurrency (default 1)
#   PROVER_*, MALLOC_*,      memory mode (README), allocator and thread settings,
#   RAYON_NUM_THREADS        passed to the backend and recorded in the summary
set -euo pipefail
rpc="${1:?usage: prover/measure.sh RPC_URL -- CLIENT_COMMAND [ARG ...]}"; shift
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "usage: prover/measure.sh RPC_URL -- CLIENT_COMMAND [ARG ...]" >&2; exit 2; }
BUILD_DIR="${ARBITER_PROVER_BUILD:-$HOME/.cache/arbiter-prover}"
bin="$BUILD_DIR/bin/starknet_transaction_prover"
[ -x "$bin" ] || { echo "no backend at $bin: run prover/build.sh" >&2; exit 1; }
port="${MEASURE_PORT:-3050}"
unit="arbiter-measure-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$BUILD_DIR/measure"
log="${MEASURE_LOG:-$BUILD_DIR/measure/$unit.log}"
backend="http://127.0.0.1:$port"
props=(-p MemorySwapMax=0)
[ -n "${MEASURE_MEMORY_MAX:-}" ] && props+=(-p "MemoryMax=$MEASURE_MEMORY_MAX")

RPC_URL="$rpc" CHAIN_ID="${CHAIN_ID:-SN_SEPOLIA}" PROVER_IP=127.0.0.1 PROVER_PORT="$port" \
MAX_CONCURRENT_REQUESTS="${MAX_CONCURRENT_REQUESTS:-1}" PREFETCH_STATE=true \
CARGO_TOOLS_ROOT="$BUILD_DIR/tools" LOG_FORMAT=json \
RUST_LOG="${RUST_LOG:-warn,starknet_transaction_prover=info,privacy_prove=info}" \
  systemd-run --user --scope --quiet --unit="$unit" "${props[@]}" "$bin" --no-cors >"$log" 2>&1 &
pid=$!
trap 'systemctl --user stop "$unit.scope" 2>/dev/null || true; wait $pid 2>/dev/null || true' EXIT

started=$(date +%s.%N)
until curl -sf -X POST "$backend" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"starknet_specVersion","params":[]}' >/dev/null; do
  kill -0 $pid 2>/dev/null || { echo "backend exited (log: $log)" >&2; tail -5 "$log" >&2; exit 1; }
  sleep 0.5
done
ready=$(date +%s.%N)
cg="/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$unit.scope")"
idle=$(cat "$cg/memory.current")

client_exit=0
BACKEND_URL="$backend" MEASURE_CGROUP="$cg" "$@" || client_exit=$?

peak=$(cat "$cg/memory.peak")
oom_kills=$(awk '$1=="oom_kill"{print $2}' "$cg/memory.events")
alive=true; kill -0 $pid 2>/dev/null || alive=false
jq -cn --arg build "$BUILD_DIR" --arg log "$log" --argjson client_exit "$client_exit" \
  --argjson startup "$(echo "$ready - $started" | bc)" --argjson idle "$idle" --argjson peak "$peak" \
  --argjson oom_kills "${oom_kills:-0}" --argjson alive "$alive" --arg memory_max "${MEASURE_MEMORY_MAX:-}" \
  --arg mode "$(env | grep -E '^(PROVER_(LOW_MEMORY|CAIRO_COEFFICIENTS|RECOMPUTE_CAIRO_COMMITMENTS|BOUNDED_[A-Z]+_COLUMNS|MALLOC_TRIM)|MALLOC_[A-Z_]+|RAYON_NUM_THREADS)=' | sort | paste -sd' ')" \
  --slurpfile events <(jq -c 'select(.fields.os_duration_ms or .fields.prove_duration_ms) | .fields' "$log" 2>/dev/null || true) \
  '{measure: {build: $build, mode: $mode, memory_max: $memory_max, startup_seconds: ($startup * 10 | round / 10),
    idle_gib: ($idle / 1073741824 * 100 | round / 100), peak_gib: ($peak / 1073741824 * 100 | round / 100),
    oom_kills: $oom_kills, backend_alive: $alive, client_exit: $client_exit,
    os_ms: [$events[] | .os_duration_ms // empty | tonumber], prove_ms: [$events[] | .prove_duration_ms // empty | tonumber],
    log: $log}}'
