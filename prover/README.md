# referee prover

Self-hosted native proofs for referee games. `@referee/sdk/proving` sends a
session's settlement to a `starknet_proveTransaction` endpoint. By default that
is StarkWare's hosted alpha prover; this directory runs the same endpoint
yourself:

| Process | What it is |
| --- | --- |
| backend | StarkWare's `starknet_transaction_prover` (the service behind the hosted prover), built from source at the sequencer revision in [`pins.json`](pins.json), with referee's [memory patches](#memory). It runs the adapter's virtual transaction in the virtual OS and proves it with Stwo in process. **PROOF1.** |
| gateway | [`server.mjs`](server.mjs): the same JSON-RPC API in front of the backend. It admits only referee settlements (below), queues and rate-limits them, proves each on its own [isolated worker](#isolation), and maps capacity errors. |

Point a client at the gateway: `proveSession({ proverUrl: 'http://host:3100', ... })`.
Nothing else changes: the proof, its facts and the `settle` call are exactly
what the hosted prover returns, and the network verifies them the same way.

**Trust.** The server sees public transcripts and signatures, never session
keys. It can delay or refuse a proof but cannot forge a result. Anyone can run
one, and direct onchain replay and disputes remain the fallback.

## Admission

Before a request takes a proving slot, the gateway checks:
- it is a zero-fee virtual `INVOKE_V3` against a `{ block_hash }` or
  `{ block_number }`, with calldata under `max_calldata` felts;
- at that block, the sender's class is in `adapter_classes` (an allowlist of
  referee adapter classes, like the channel's own);
- that adapter pins `virtual_os_program`, the program the backend runs, so the
  proof can settle.

The backend repeats its own checks (account validation, zero fees). Per-client
rate limits and a bounded queue keep one client from holding the prover.

## Results (Sepolia, 2026-09-26)

On a 36-core, 125 GiB machine (`TARGET_CPU=native`), with the RPC node on
another host behind an SSH tunnel:
- **Settled:** Surround's `cgos_13_277988` (203 steps, W+20.5) was proved by
  this server and settled on Sepolia by the channel's adapter.
- **Identical proofs:** re-proving five recorded settlements at their original
  base blocks gave proofs byte-identical to the hosted prover's, with the same
  facts (Surround's `offchain/server/tools/prove-bench.mjs`).
- **Refusals:** a request from a non-allowlisted adapter (Surround's retired
  v1 class) was refused in 0.7 s, before proving.

| Game | Steps | OS run | Proof | Total (client) | Hosted prover |
| --- | ---: | ---: | ---: | ---: | ---: |
| cgos_9_1682833 | 68 | 7.8 s (cold class cache) | 7.4 s | 16.7 s | 4.9 s |
| cgos_13_277988 | 203 | 3.7 s | 10.0 s | 15.2 s | — |
| kgs_2019_04_26_17 | 319 | 3.8 s | 13.2 s | 18.7 s | 6.9 s |
| stress_19_3 | 479 | 4.6 s | 14.1 s | 20.2 s | 8.4 s |
| stress_19_2 | 529 | 4.8 s | 14.1 s | 20.4 s | 8.3 s |

With `prefetch_state` off, the OS run of the 203-step game took 31.4 s: the
backend then reads state one RPC call at a time, and the node was remote. Keep
it on, and keep the node close. For memory, see [Memory](#memory).

**Submitting proofs.** Estimate and send `settle` through an RPC node whose
versioned constants match the sequencer's. Pathfinder v0.24.0 rejected this
PROOF1 in simulation ("Proof version PROOF1 is not allowed under this protocol
version") while the Sepolia sequencer accepted it; upstream's 0.14.4 constants
allow PROOF1 and PROOF2, and a second virtual OS program
(`0x1c7be3…d324`) that PROOF2 adapters may need to pin.

## Memory

The config's `memory` chooses how the backend holds a proof's working data.
Both modes produce byte-identical proofs and facts, so clients and the chain
cannot tell them apart; only memory and time differ.

| `memory` | What the backend keeps | Largest game: memory | Proof time |
| --- | --- | ---: | ---: |
| `standard` (default) | Upstream: preprocessed trees and a column pool shared by all proofs | 40 GiB (46 with mixed games) | 16 s |
| `bounded` | Each proof's own trees; polynomial coefficients instead of expanded columns; Merkle layers rebuilt when opened; FRI quotients 16 columns at a time | 22 GiB | 35 s |

**Choosing.** `standard` is faster per proof and, on a large machine, has the
higher throughput too: use it where memory allows. `bounded` fits hosts that
`standard` does not (a 32 GiB host fits one `bounded` job and no `standard`
one; a 64 GiB host, two `bounded` jobs or one `standard`), and gives memory
back between proofs on a shared host. Budget per worker about 38 GiB in
`standard` (46 once it has proved games of mixed sizes) and 22 GiB in
`bounded`. Each worker's memory limit (`workers.job_memory`, by default 56 and
28 GiB) leaves headroom over that, and a job that reaches it fails alone
([Isolation](#isolation)). On the 125 GiB machine below, with copies of the
largest game started together:

| `memory` | `max_concurrent` | Peak, all workers | Seconds per proof |
| --- | ---: | ---: | ---: |
| `standard` | 1 | 37.1 GiB | 24.8 |
| `standard` | 2 | 73.9 GiB | 17.7 |
| `bounded` | 1 | 21.8 GiB | 43 |
| `bounded` | 4 | 79.7 GiB | 27.7 |

(Wall time divided by proofs, OS run included; `bounded` with one worker was
measured as one backend proving in sequence.) A second `standard` worker adds
about 40% throughput; each keeps its own precomputes and column pool. On this
machine: `standard` with `max_concurrent: 2`.

**Allocator.** Workers start with a fixed 1 MiB glibc mmap threshold
(`MALLOC_MMAP_THRESHOLD_`) in both modes. Without it, freed proving
buffers stay in the heap and a long-running backend grows with every proof:
eight proofs of the largest game took `standard` from 39 to 48 GiB and
`bounded` from 22 to 38 GiB, still rising. With it, both stay flat (39.5 and
21.8 GiB), and `bounded` drops to about 1 GiB between proofs. It costs about
10% of proof time in `standard` and 20% in `bounded`.

**Measurements** (2026-09-27, same machine, `TARGET_CPU=native`, swap off):
one fresh backend per proof, peak from its cgroup's `memory.peak`
([`measure.sh`](measure.sh)), proof time from the backend's own log. The five
fixtures were proved at Sepolia block 15694989 from epoch-0 measurement games
on the v2 channel (Surround's `measure.mjs game` and `os-job.mjs`), because the
node no longer served storage proofs for the recorded settlements' blocks.
Without the mmap threshold:

| Game | Steps | `standard` | `bounded` | `standard` proof | `bounded` proof |
| --- | ---: | ---: | ---: | ---: | ---: |
| cgos_9_1682833 | 68 | 24.5 GiB | 11.4 GiB | 8.0 s | 16.3 s |
| cgos_13_277988 | 203 | 27.6 GiB | 15.4 GiB | 10.5 s | 20.7 s |
| kgs_2019_04_26_17 | 319 | 35.8 GiB | 20.6 GiB | 13.9 s | 26.9 s |
| stress_19_3 | 479 | 40.0 GiB | 22.2 GiB | 14.8 s | 29.3 s |
| stress_19_2 | 529 | 39.5 GiB | 21.8 GiB | 15.4 s | 29.7 s |

- **Identical proofs:** 119 proofs across both modes, stock and patched
  binaries, batch sizes 4–256, allocator settings, 1–4 concurrent jobs and the
  gateway gave one proof and one set of facts per game, each matching the
  requested transition, block and OS program.
- **Where the peak is:** in the Cairo stage, which still expands one full
  commitment tree at a time. FRI batches from 4 to 256 columns, or bounding
  only the Cairo stage, change neither memory nor time measurably, so the batch
  size is fixed at 16.
- **Not exposed:** stage-local proving without bounded columns
  (`PROVER_LOW_MEMORY=1` alone) saves only 3–5 GiB on large games for about 25%
  more time.

**Patches.** [`patches/`](patches) carries the work from Templar's
prover-memory, cairo-memory and bounded-memory experiments, one patch per
repository against the exact revisions the sequencer's `Cargo.lock` pins
(proving-utils 3035dd0, stwo 489a0f3, stwo-cairo 9b6be27, stwo-circuits
5ef951a, in `pins.json`). They change how the prover stores data, not what it
proves. Without `PROVER_LOW_MEMORY=1` the backend runs upstream's code paths.
`stwo`'s own tests (267, with and without `parallel`) pass with them. The
sequencer patch adds the backend's settings, which the gateway sets from
`memory`:

| Variable | Meaning |
| --- | --- |
| `PROVER_LOW_MEMORY=1` | Per-proof trees and buffer pools, nothing shared between proofs. |
| `PROVER_BOUNDED_CAIRO_COLUMNS`, `PROVER_BOUNDED_CIRCUIT_COLUMNS` | `N > 0`: coefficients instead of expanded columns, FRI quotients `N` columns at a time. Require `PROVER_LOW_MEMORY=1`. |
| `PROVER_RECOMPUTE_CAIRO_COMMITMENTS`, `PROVER_CAIRO_COEFFICIENTS` | Low-memory details, default 1. |

Moving to a new sequencer revision means regenerating the patches against the
revisions its lockfile pins; `build.sh` refuses a mismatch.

## Isolation

The gateway runs the backend as `max_concurrent` workers: long-running
backends that prove one job at a time, each in its own cgroup v2 group
([`workers.mjs`](workers.mjs)).

- **Limits.** Each worker's group gets a memory limit (`workers.job_memory`),
  no swap, a PID limit (`workers.pids_max`, 1024) and optionally a CPU quota
  (`workers.job_cpus`). An out-of-memory kill takes that worker's whole group
  and nothing else.
- **Failures.** A job that runs out of memory, times out (`backend_timeout_ms`)
  or loses its backend fails with code `1103`, and `data.reason` says which
  (`memory`, `timeout`, `exited`, `unreachable`). The gateway kills the
  worker's whole group, including anything it started, and starts a fresh
  backend in its place; other jobs carry on. An idle worker that dies is
  replaced the same way.
- **Warm workers.** Workers stay up between jobs, so the backend's
  compiled-class cache and precomputes stay warm: a fresh backend's OS run
  took 7–10 s, a warm one's 3–5 s.
- **Network.** Workers keep network access: the in-process backend reads chain
  state from the RPC node while it proves. Transcripts and signatures are
  public, so there is no witness to keep in (Templar's no-network steps
  protected private ones). PROOF2's offline prove step can run without it.
- **Delegation.** The groups live under a delegated cgroup subtree,
  `workers.cgroup_root`. With `"self"` (the default) the gateway's own cgroup
  is the subtree: the gateway moves itself into a `gateway` leaf and runs its
  workers in sibling groups. `run.sh` gets one from a systemd user scope with
  `Delegate=yes`. At startup the gateway checks that it can create a limited
  group and start a process in it, and refuses to start otherwise.
  `workers.sandbox: "none"` runs workers as plain processes without limits, for
  development only; `backend_url` forwards to a backend you run yourself, with
  no isolation.

Checked with the real backend (2026-09-27): two `bounded` workers proved the
529- and 319-step games at once (peaks 21.8 and 20.1 GiB under 28 GiB, then
back to about 1 GiB); with an 8 GiB limit the 529-step game failed after 15 s
with reason `memory` and its worker came back; with a 5 s timeout the job
failed with reason `timeout` and its backend was killed with its group.

## Build

Requirements: Rust via rustup (the build installs `nightly-2026-01-15`),
cairo-lang 0.14.3a3 for `cairo-compile` (the virtual OS compiles at build time),
clang, cmake and about 5 GB of disk for the build. The first build takes
about 15 minutes on 36 cores.

```bash
pip install cairo-lang==0.14.3a3            # or point CAIRO_LANG_BIN at its bin/
TARGET_CPU=native prover/build.sh
```

The build clones the pinned sequencer and the four proving dependencies it
locks into `~/.cache/referee-prover` (`REFEREE_PROVER_BUILD`), applies
[`patches/`](patches), builds the backend with in-process Stwo proving against
the patched copies, installs the Sierra compiler it uses at runtime, and
records the build (including the patches' hashes) in `build.json`.
`TARGET_CPU=native` makes proofs faster but ties the binary to the CPU.

## Run

Copy [`config.example.json`](config.example.json) and set:

| Field | Meaning |
| --- | --- |
| `chain_id`, `rpc_url` | The network and a Starknet RPC v0.10 node. A local node is recommended: the OS run reads a lot of state. |
| `virtual_os_program` | The program adapters pin and the backend runs (`pins.json`). |
| `adapter_classes` | Allowlisted adapter class hashes. |
| `max_concurrent`, `max_queued` | Workers, each proving one job at a time (see [Memory](#memory) for the budget), and waiting requests. |
| `memory` | `standard` (default) or `bounded`: see [Memory](#memory). |
| `workers` | `cgroup_root` (`"self"`), `base_port` (3200; worker `i` listens on `base_port + i` on localhost), `job_memory` (by `memory`: 56G or 28G), `job_cpus` (no quota), `pids_max` (1024), `sandbox` (`"cgroup"`, or `"none"` for development): see [Isolation](#isolation). |
| `build_dir` | The build to run (default `$REFEREE_PROVER_BUILD`, else `~/.cache/referee-prover`). |
| `backend_url` | Instead of workers, forward to a backend you run yourself, without isolation. |
| `prefetch_state` | Fetch the transaction's state up front with one simulation (default true). |
| `max_calldata`, `rate_per_minute`, `backend_timeout_ms` | Request size, per-client rate and backend timeout. |

```bash
prover/run.sh my-config.json
```

`run.sh` runs the gateway in a systemd user scope with `Delegate=yes`; the
gateway starts its workers, waits until each answers, then serves. It logs one
JSON line per request (client, sender, block, calldata size, outcome, time)
and per worker restart; the workers' own logs follow on stderr, each line
prefixed `worker-N:`. `GET /health` answers `ok`.

## Deploy

Both setups in [`deploy/`](deploy) give the gateway the delegated cgroup its
workers need, and run it as an unprivileged `referee` user.

**systemd** (recommended): [`referee-prover.service`](deploy/referee-prover.service)
runs the gateway with `Delegate=yes`. Install the repository at `/opt/referee`
(`npm ci --omit=dev`), build with
`REFEREE_PROVER_BUILD=/var/lib/referee-prover/build prover/build.sh`, put the
config at `/etc/referee/prover.json`, and size the unit's `MemoryMax` to the
workers (`max_concurrent` × `workers.job_memory`, plus the gateway).

**Docker**: [`Dockerfile`](deploy/Dockerfile) builds the backend with
`build.sh` (build argument `CPU`: `x86-64-v3` by default, or `native`) into an
image with the gateway. Its [entrypoint](deploy/entrypoint.sh) remounts the
container's private cgroup namespace writable, hands it to `referee`, and drops
every capability before starting the gateway:

```bash
docker build -f prover/deploy/Dockerfile -t referee-prover .
docker run -d --name referee-prover --cgroupns=private --cap-add SYS_ADMIN \
  --security-opt apparmor=unconfined --network host --memory 120g --memory-swap 120g \
  -v /etc/referee/prover.json:/etc/referee/prover.json:ro referee-prover
```

`SYS_ADMIN` (and, on AppArmor hosts, `apparmor=unconfined`) is only for the
remount; `--network host` lets the gateway reach a local RPC node and listen
on its configured port.

Checked 2026-09-27: the image (`x86-64-v3`) ran its gateway as `referee` with
no capabilities and proved the 529-step game on a worker in 26.6 s (24.8 s
with a `native` build), and the unit's cgroup settings, as a user service,
proved the 319-step game; both proofs were byte-identical to native builds'.

## API

JSON-RPC 2.0 on `/`:
- `starknet_proveTransaction { block_id, transaction }` returns
  `{ proof, proof_facts, l2_to_l1_messages }`, as the hosted prover does;
- `starknet_specVersion` is the backend's version;
- `referee_info` returns the chain, OS program, allowlisted classes, proof paths,
  memory mode, workers (ready, busy, restarts) and limits.

| Code | Meaning |
| --- | --- |
| `24` | Block not found |
| `1000` | Not a zero-fee INVOKE_V3, malformed, or calldata too large (settle in checkpoints) |
| `1100` | Sender is not an allowlisted referee adapter |
| `1101` | The adapter pins another virtual OS program |
| `1102` | The transaction exceeds PROOF1; settle in checkpoints |
| `1103` | The proving job failed: out of memory, timed out, or its backend stopped (`data.reason`); retry later |
| `-32005` | Queue full; retry later |
| `-32029` | Rate limited |

Backend errors such as `55` (account validation failed, e.g. an illegal
transcript) pass through unchanged.

## PROOF2

The network does not accept PROOF2 yet (expected about 2026-10-10). Then a
large-path backend joins this one: Templar's virtual-OS runner and
bounded-memory prover (`broody/proving`), which fit a full proof in about
28 GiB. The gateway will route a job that overflows PROOF1 (code `1102` today)
to it. `referee_adapter` already accepts PROOF2 facts. If PROOF2 proofs attest
the newer virtual OS program rather than the one adapters pin today, each game
deploys one new adapter instance pinning it and allowlists it; channels and
games are unaffected.

## Tests

`node --test prover/test/*.test.mjs` runs the gateway against a mock node and
mock backends, as an external backend and as workers without cgroups.
[`test/cgroup.sh`](test/cgroup.sh) runs the worker tests that need real
cgroups (limits, a job killed for memory alone, a timeout killing a whole
group) in a delegated systemd user scope. `scripts/check.sh` runs both. [`measure.sh`](measure.sh) starts a
backend in its own cgroup, runs any client against it, and reports peak memory
and the backend's OS-run and proof times.
