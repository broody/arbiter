# arbiter prover

Self-hosted native proofs for arbiter games. `@arbiter/sdk/proving` sends a
session's settlement to a `starknet_proveTransaction` endpoint. By default that
is StarkWare's hosted alpha prover; this directory runs the same endpoint
yourself:

| Process | What it is |
| --- | --- |
| backend | StarkWare's `starknet_transaction_prover` (the service behind the hosted prover), built from source at the sequencer revision in [`pins.json`](pins.json), with its prover crates taken from Outis's striped branch of them ([Memory](#memory)). It runs the adapter's virtual transaction in the virtual OS and proves it with Stwo in process. **PROOF2.** |
| gateway | [`server.mjs`](server.mjs): the same JSON-RPC API in front of the backend. It admits only arbiter settlements (below), queues and rate-limits them, proves each on its own [isolated worker](#isolation), and maps capacity errors. |

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
  arbiter adapter classes, like the channel's own);
- that adapter pins `virtual_os_program`, the program the backend runs, so the
  proof can settle.

The backend repeats its own checks (account validation, zero fees). Per-client
rate limits and a bounded queue keep one client from holding the prover.

## Results (Sepolia, 2026-10-30)

On a 36-core, 125 GiB machine (i9-10980XE, `TARGET_CPU=native`, 36 threads),
with the RPC node on another host behind an SSH tunnel. Each game is a fresh
Surround game nobody opened, proved from its terms at epoch 0 against Sepolia's
v8 adapter, as captured by Surround's `offchain/server/tools/device-bench.mjs`
(nothing broadcast). A fresh backend per game, under [`measure.sh`](measure.sh):

| Game | Steps | OS steps | OS run | Proof | Total (client) | Peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cgos_9_1682833 | 68 | 653,017 | 5.3 s (cold class cache) | 9.7 s | 15.0 s | 2.7 GiB |
| cgos_13_277988 | 203 | 1,071,564 | 5.7 s | 12.0 s | 17.7 s | 4.1 GiB |
| kgs_2019_04_26_17 | 319 | 1,426,325 | 7.2 s | 11.3 s | 18.5 s | 4.3 GiB |
| kgs_2019_04_10_39 | 311 | 1,437,879 | 6.3 s | 10.7 s | 17.0 s | 4.3 GiB |
| stress_19_3 | 479 | 2,134,063 | 7.1 s | 17.6 s | 24.8 s | 6.6 GiB |
| stress_19_2 | 529 | 2,379,871 | 7.9 s | 15.8 s | 23.7 s | 6.8 GiB |

- **Identical proofs:** every proof, its facts and its message equal those of
  Outis's device prover (outis-wallet/prover v0.3.2, wasm or native) for the
  same transaction at the same block. That prover's own references are
  StarkWare's transaction prover's, unpatched, at the same sequencer revision.
- **Warm:** one backend proving four of them in a row took 15–20 s each (OS
  run 5.0–6.3 s, proof 10.0–14.1 s), and peaked at 7.2 GiB.
- **Settled:** Surround's `kgs_2019_04_10_39` (311 steps, B+1.50), proved by
  this gateway in 23.4 s, opened and settled on Sepolia in one transaction
  through an adapter instance pinned to PROOF2's program
  (`0x1b8c548d…8a23`): 99.39M L2 gas, the same as a PROOF1 open-and-settle.
- **Refusals:** Sepolia's earlier v8 adapter pins PROOF1's virtual OS program,
  so the gateway refuses its transactions with `1101` before proving
  ([PROOF1 adapters](#proof1-adapters)).

The PROOF1 backend this one replaced (2026-09-26 to 2026-10-30) proved the
same games in 15–20 s end to end, peaking at 9.0 GiB in its `bounded` mode and
40 GiB in `standard`, and settled a Surround game on Sepolia. With
`prefetch_state` off, a remote node made its OS run of the 203-step game take
31.4 s: keep it on, and keep the node close.

**Submitting proofs.** Estimate and send `settle` through an RPC node whose
versioned constants match the sequencer's: Pathfinder v0.24.0 rejected a PROOF1
in simulation ("Proof version PROOF1 is not allowed under this protocol
version") that the Sepolia sequencer accepted. Our Pathfinder node estimated and
sent the PROOF2 `settle` above.

## Memory

The backend takes its prover crates from Outis's branch of
starkware-libs/proving ([`pins.json`](pins.json)): `e0035ffc`, the revision the
sequencer locks, plus a striped prover, in which each committed column keeps
one stripe of its eight and the rest is evaluated again when read (the
branch's `OUTIS.md`). The proofs are byte-identical to upstream's, and the same
crates prove Outis's privacy-pool transactions on phones and in browsers. There
is one mode: PROOF1's `memory` modes and their patches are gone, and the
gateway refuses a config that still sets `memory`.

- **Budget.** The largest game peaks at about 7 GiB (above), and a backend
  gives its memory back between proofs, to about 1.3 GiB, with no allocator
  settings (PROOF1's needed a heap trim or an mmap threshold). Each worker's
  limit, `workers.job_memory`, is 12 GiB by default; a job that reaches it
  fails alone ([Isolation](#isolation)). So a 16 GiB host can run one worker,
  and a 32 GiB host two, with the limit lowered to leave the system room (not
  tried on such hosts).
- **Threads.** Workers that share the machine prove faster with a share of its
  cores each than with one thread per core each, so with `max_concurrent`
  above 1 each worker gets `RAYON_NUM_THREADS` of cores divided by workers
  (`workers.job_threads`, or `workers.job_cpus` rounded when that is set).
  Several workers' throughput hasn't been measured on this backend yet.

**The patch.** [`patches/sequencer.patch`](patches/sequencer.patch) is a Cargo
`[patch]` that points every crate the sequencer takes from
starkware-libs/proving (25 of them) at the pinned branch, and the lockfile it
gives; `build.sh` checks that the lock takes them all from there. Moving to a
new sequencer revision means a branch of proving at the revision that one
locks, and a new patch. The patch and the branch modify StarkWare's
repositories, which are licensed Apache-2.0, and keep that license; the rest of
arbiter is MIT ([`LICENSE`](../LICENSE)).

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
  protected private ones).
- **Delegation.** The groups live under a delegated cgroup subtree,
  `workers.cgroup_root`. With `"self"` (the default) the gateway's own cgroup
  is the subtree: the gateway moves itself into a `gateway` leaf and runs its
  workers in sibling groups. `run.sh` gets one from a systemd user scope with
  `Delegate=yes`. At startup the gateway checks that it can create a limited
  group and start a process in it, and refuses to start otherwise.
  `workers.sandbox: "none"` runs workers as plain processes without limits, for
  development only; `backend_url` forwards to a backend you run yourself, with
  no isolation.

Checked with the PROOF1 backend (2026-09-27): two `bounded` workers proved the
529- and 319-step games at once (peaks 21.8 and 20.1 GiB under 28 GiB, then
back to about 1 GiB); with an 8 GiB limit the 529-step game failed after 15 s
with reason `memory` and its worker came back; with a 5 s timeout the job
failed with reason `timeout` and its backend was killed with its group.

## Build

Requirements: Rust via rustup (the build installs `nightly-2026-01-15`),
cairo-lang 0.14.3a3 for `cairo-compile` (the virtual OS compiles at build time),
clang, cmake and about 5 GB of disk for the build. A build took about 4
minutes on 36 cores.

```bash
pip install cairo-lang==0.14.3a3            # or point CAIRO_LANG_BIN at its bin/
TARGET_CPU=native prover/build.sh
```

The build clones the pinned sequencer into `~/.cache/arbiter-prover`
(`ARBITER_PROVER_BUILD`), applies [`patches/`](patches), builds the backend with
in-process Stwo proving (Cargo fetches the pinned proving branch), installs the
Sierra compiler it uses at runtime, and records the build (including the
patches' hashes) in `build.json`. The gateway starts workers only from a build
with the current patches, so a PROOF1 build left in the directory is refused
until `build.sh` runs again. `TARGET_CPU=native` makes proofs faster but ties
the binary to the CPU.

## Run

Copy [`config.example.json`](config.example.json) and set:

| Field | Meaning |
| --- | --- |
| `chain_id`, `rpc_url` | The network and a Starknet RPC v0.10 node. A local node is recommended: the OS run reads a lot of state. |
| `virtual_os_program` | The program adapters pin and the backend runs (`pins.json`). |
| `adapter_classes` | Allowlisted adapter class hashes. |
| `max_concurrent`, `max_queued` | Workers, each proving one job at a time (see [Memory](#memory) for the budget and threads), and waiting requests. |
| `workers` | `cgroup_root` (`"self"`), `base_port` (3200; worker `i` listens on `base_port + i` on localhost), `job_memory` (12G), `job_cpus` (no quota), `job_threads` (proving threads; by default cores divided by `max_concurrent`, see [Memory](#memory)), `pids_max` (1024), `sandbox` (`"cgroup"`, or `"none"` for development): see [Isolation](#isolation). |
| `build_dir` | The build to run (default `$ARBITER_PROVER_BUILD`, else `~/.cache/arbiter-prover`). |
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
workers need, and run it as an unprivileged `arbiter` user.

**systemd** (recommended): [`arbiter-prover.service`](deploy/arbiter-prover.service)
runs the gateway with `Delegate=yes`. Install the repository at `/opt/arbiter`
(`npm ci --omit=dev`), build with
`ARBITER_PROVER_BUILD=/var/lib/arbiter-prover/build prover/build.sh`, put the
config at `/etc/arbiter/prover.json`, and size the unit's `MemoryMax` to the
workers (`max_concurrent` × `workers.job_memory`, plus the gateway).

**Docker**: [`Dockerfile`](deploy/Dockerfile) builds the backend with
`build.sh` (build argument `CPU`: `x86-64-v3` by default, or `native`) into an
image with the gateway. Its [entrypoint](deploy/entrypoint.sh) remounts the
container's private cgroup namespace writable, hands it to `arbiter`, and drops
every capability before starting the gateway:

```bash
docker build -f prover/deploy/Dockerfile -t arbiter-prover .
docker run -d --name arbiter-prover --cgroupns=private --cap-add SYS_ADMIN \
  --security-opt apparmor=unconfined --network host --memory 120g --memory-swap 120g \
  -v /etc/arbiter/prover.json:/etc/arbiter/prover.json:ro arbiter-prover
```

`SYS_ADMIN` (and, on AppArmor hosts, `apparmor=unconfined`) is only for the
remount; `--network host` lets the gateway reach a local RPC node and listen
on its configured port.

Checked with the PROOF1 backend (2026-09-27): the image (`x86-64-v3`) ran its
gateway as `arbiter` with no capabilities and proved the 529-step game on a
worker in 26.6 s (24.8 s with a `native` build), and the unit's cgroup
settings, as a user service, proved the 319-step game; both proofs were
byte-identical to native builds'. Not yet rebuilt with the PROOF2 backend.

## API

JSON-RPC 2.0 on `/`:
- `starknet_proveTransaction { block_id, transaction }` returns
  `{ proof, proof_facts, l2_to_l1_messages }`, as the hosted prover does;
- `starknet_specVersion` is the backend's version;
- `arbiter_info` returns the chain, OS program, allowlisted classes, proof paths,
  workers (ready, busy, restarts) and limits.

| Code | Meaning |
| --- | --- |
| `24` | Block not found |
| `1000` | Not a zero-fee INVOKE_V3, malformed, or calldata too large (settle in checkpoints) |
| `1100` | Sender is not an allowlisted arbiter adapter |
| `1101` | The adapter pins another virtual OS program |
| `1102` | The transaction exceeds the prover's capacity; settle in checkpoints (PROOF1's "Not enough twiddles"; not yet seen on this backend) |
| `1103` | The proving job failed: out of memory, timed out, or its backend stopped (`data.reason`); retry later |
| `-32005` | Queue full; retry later |
| `-32029` | Rate limited |

Backend errors such as `55` (account validation failed, e.g. an illegal
transcript) pass through unchanged.

## PROOF1 adapters

Until 2026-10-30 this backend made PROOF1, at sequencer `625929a` with
arbiter's bounded-memory patches. Adapters deployed before then pin PROOF1's
virtual OS program (`PROOF1_VIRTUAL_OS_PROGRAM` in `@arbiter/sdk/proving`), and
this backend's proofs can't settle on them. A game deploys one new instance of
the same adapter class pinning PROOF2's (`VIRTUAL_OS_PROGRAM`), and names it in
the terms of games signed after that; the channel's allowlist is by class, so
channels and older games are unaffected.

## Tests

`node --test prover/test/*.test.mjs` runs the gateway against a mock node and
mock backends, as an external backend and as workers without cgroups.
[`test/cgroup.sh`](test/cgroup.sh) runs the worker tests that need real
cgroups (limits, a job killed for memory alone, a timeout killing a whole
group) in a delegated systemd user scope. `scripts/check.sh` runs both. [`measure.sh`](measure.sh) starts a
backend in its own cgroup, runs any client against it, and reports peak memory
and the backend's OS-run and proof times.
