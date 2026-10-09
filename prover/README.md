# arbiter prover

Self-hosted native proofs for arbiter games. `@arbiter/sdk/proving` sends a
session's settlement to a `starknet_proveTransaction` endpoint. By default that
is StarkWare's hosted alpha prover; this directory runs the same endpoint
yourself:

| Process | What it is |
| --- | --- |
| backend | StarkWare's `starknet_transaction_prover` (the service behind the hosted prover), built from source at the sequencer revision in [`pins.json`](pins.json), with arbiter's [memory patches](#memory). It runs the adapter's virtual transaction in the virtual OS and proves it with Stwo in process. **PROOF1.** |
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

| `memory` | What the backend keeps | Largest game: peak | Proof |
| --- | --- | ---: | ---: |
| `standard` | Upstream: every column expanded to 8x the trace, preprocessed trees and a column pool shared by all proofs | 40 GiB | 14 s |
| `bounded` (default) | Each proof's own trees; polynomial coefficients instead of expanded columns, committed a stripe at a time; Merkle layers kept, queried rows evaluated from coefficients | 9 GiB | 19 s |

**Choosing.** `bounded` is the default: on a large machine it has about the
same throughput as `standard` on half the memory or less, and it fits hosts
where `standard` does not. `standard` has the lower latency for one job. A
`bounded` worker needs about 10 GiB for the largest game, so a 16 GiB host can
run one worker and a 32 GiB host two, with `workers.job_memory` lowered to
leave the system room (not tried on such hosts). Each worker's memory limit
(`workers.job_memory`, by default 56 GiB in `standard` and 16 GiB in
`bounded`) leaves headroom over its peak (a fresh backend's cgroup, cold class
cache included, peaked at 39.3 and 9.9 GiB on the largest live job, through
[`measure.sh`](measure.sh)), and a job that reaches it fails alone
([Isolation](#isolation)). On the 36-core, 125 GiB machine below, with copies
of the largest game started together (prover time only, three proofs per
worker):

| `memory` | Workers × threads | Peak per worker | All workers, at most | Seconds per proof |
| --- | ---: | ---: | ---: | ---: |
| `standard` | 1 × 36 | 41.1 GiB | 41 GiB | 15.4 |
| `standard` | 2 × 18 | 40.9 GiB | 82 GiB | 12.9 |
| `bounded` | 1 × 36 | 9.8 GiB | 10 GiB | 19.2 |
| `bounded` | 3 × 12 | 9.1 GiB | 27 GiB | 13.4 |
| `bounded` | 4 × 9 | 8.6 GiB | 34 GiB | 13.2 |
| `bounded` | 6 × 6 | 8.6 GiB | 52 GiB | 12.6 |

(The earlier default deployment, `standard` with two workers of 36 threads
each and the mmap threshold: 14.0 s per proof.)

Workers that share the machine prove faster with a share of its cores each
than with one thread per core each, so with `max_concurrent` above 1 each
worker gets `RAYON_NUM_THREADS` of cores divided by workers
(`workers.job_threads`, or `workers.job_cpus` rounded when that is set). On
this machine: `bounded` with `max_concurrent: 6`, or `standard` with 2 where
the latency of a single job matters more than memory.

**How `bounded` works.** It keeps each column's coefficients (the trace's
size) where `standard` keeps its evaluation on a domain 8 times larger. The
ideas below come from provingly's client-side prover (a striped prover after
ryun1's public description), which proves Outis privacy-pool transactions in
about 2.5 GiB on phones and in browsers.
- **Striped commitment.** In bit-reversed order, the k-th eighth of a
  column's expanded evaluation (a stripe) is its evaluation on a coset of the
  trace's size, and the leaves that read the k-th stripe of every column are
  the leaves of a lifted tree of those stripes. So the backend evaluates one
  stripe of every column at a time, hashes its leaves, and builds the layers
  above on all the leaves. A commitment never holds more than one stripe of
  each column; earlier, `bounded` expanded one whole tree (15 GiB for the
  largest game's base trace).
- **Openings from coefficients.** The Merkle layers are kept (0.5 GiB for a
  tree of 2^23 leaves), and a queried row is evaluated from the coefficients
  (provingly's `domain_eval`: one pass over each column per group of queries)
  instead of re-expanding and re-hashing every tree when it is opened, which
  took 8 s.
- **Regeneration.** Constraint evaluation and the FRI quotients read the first
  two eighths and the first eighth of each column; `bounded` evaluates those
  from the coefficients, all of a component's columns at once.

**Allocator.** A backend built with the current patches gives glibc's freed
heap back after each proof (`PROVER_MALLOC_TRIM=1`), so a long-running worker
stays flat between proofs (about 1 GiB in `bounded`). Without it, freed
proving buffers stay in the heap and a worker grows with every proof (ten
mixed proofs: `standard` 22 to 50 GiB, `bounded` 5 to 12 GiB, still rising).
The gateway sets it for builds whose `build.json` records the current patches,
and otherwise falls back to a fixed 1 MiB mmap threshold
(`MALLOC_MMAP_THRESHOLD_`), which also keeps workers flat but costs about 6%
of proof time in `standard` and 23% in `bounded`.

**Measurements** (2026-10-09, same machine, `TARGET_CPU=native`, trim): each
proof in a fresh `prove_pie` process ([Offline proving](#offline-proving)),
from the PIEs of five fixtures proved at Sepolia block 16295160 against the
epoch-0 measurement games on the v2 channel (Surround's `os-job.mjs`). Peak is
the process's peak resident memory; time is the proof alone (the OS run, 4 to
9 s, comes before it).

| Game | Steps | OS steps | `standard` | `bounded` | `standard` proof | `bounded` proof |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cgos_9_1682833 | 68 | 798,153 | 24.7 GiB | 6.8 GiB | 8.0 s | 11.5 s |
| cgos_13_277988 | 203 | 1,169,043 | 28.1 GiB | 7.4 GiB | 9.8 s | 13.7 s |
| kgs_2019_04_26_17 | 319 | 1,480,565 | 36.2 GiB | 9.6 GiB | 12.6 s | 17.9 s |
| stress_19_3 | 479 | 2,130,431 | 39.9 GiB | 9.3 GiB | 13.5 s | 18.5 s |
| stress_19_2 | 529 | 2,357,997 | 38.6 GiB | 9.0 GiB | 14.2 s | 18.9 s |

- **Identical proofs:** every proof of these fixtures, in both modes, fresh
  or long-running, alone or with up to six workers, offline or through the
  gateway, matched the proof and facts the stock code path gave live for the
  same job.
- **Where the peak is:** in `standard`, the Cairo base and interaction
  commitments (15 and 13 GiB of expanded columns). In `bounded`, the Cairo
  witness (about 7 GiB for the largest game) plus one stripe of the trace
  during the commitments, or the regenerated columns of the largest components
  during constraint evaluation.
- **Earlier `bounded`** (whole-tree commitments, trees rebuilt when opened,
  mmap threshold): 21.7 GiB and 32.9 s for the largest game.

**Patches.** [`patches/`](patches) carries the work from Templar's
prover-memory, cairo-memory and bounded-memory experiments and provingly's
striped prover, one patch per repository against the exact revisions the
sequencer's `Cargo.lock` pins (proving-utils 3035dd0, stwo 489a0f3, stwo-cairo
9b6be27, stwo-circuits 5ef951a, in `pins.json`). They change how the prover
stores data, not what it proves. Without `PROVER_LOW_MEMORY=1` the backend
runs upstream's code paths. `stwo`'s own tests (270, with and without
`parallel`) pass with them. The sequencer patch adds the backend's settings,
which the gateway sets from `memory`:

| Variable | Meaning |
| --- | --- |
| `PROVER_LOW_MEMORY=1` | Per-proof trees and buffer pools, nothing shared between proofs. |
| `PROVER_BOUNDED_CAIRO_COLUMNS`, `PROVER_BOUNDED_CIRCUIT_COLUMNS` | `N > 0`: coefficients instead of expanded columns (above), FRI quotients `N` columns at a time. Require `PROVER_LOW_MEMORY=1`. |
| `PROVER_RECOMPUTE_CAIRO_COMMITMENTS`, `PROVER_CAIRO_COEFFICIENTS` | Low-memory details, default 1. |
| `PROVER_MALLOC_TRIM=1` | Trim glibc's heap after each proof. |
| `PROVER_PIE_DUMP=DIR` | Write each proof's Cairo PIE to `DIR` ([Offline proving](#offline-proving)). |

Moving to a new sequencer revision means regenerating the patches against the
revisions its lockfile pins; `build.sh` refuses a mismatch. The gateway
refuses `bounded` on a build whose patches are not the current ones.

## Offline proving

A live job can only be proved again while the node still serves storage
proofs for its block (about 10,000 blocks on our node). To measure the prover
alone, run a backend built by `build.sh` (a stock backend has no dump) with
`PROVER_PIE_DUMP=DIR`, for example under [`measure.sh`](measure.sh): it writes
each proof's Cairo PIE to `DIR` before proving it. Then

```bash
PROVER_LOW_MEMORY=1 PROVER_BOUNDED_CAIRO_COLUMNS=16 PROVER_BOUNDED_CIRCUIT_COLUMNS=16 \
  ~/.cache/arbiter-prover/bin/prove_pie [--repeat N] PIE.zip...
```

proves them as the backend does, in the memory mode its environment selects,
and prints one JSON line per proof: the proof's and facts' SHA-256 (the same
hashes as a client's), the proof time and the peak resident memory, reset
before each proof. With `PROVE_PIE_LOG` set to a tracing filter, for example
`warn,privacy_prove=info,stwo=info,stwo_cairo_prover=info`, every span it
enters is logged on stderr with the process's resident and peak memory, which
shows the phase that sets the peak.

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
locks into `~/.cache/arbiter-prover` (`ARBITER_PROVER_BUILD`), applies
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
| `max_concurrent`, `max_queued` | Workers, each proving one job at a time (see [Memory](#memory) for the budget and threads), and waiting requests. |
| `memory` | `bounded` (default) or `standard`: see [Memory](#memory). |
| `workers` | `cgroup_root` (`"self"`), `base_port` (3200; worker `i` listens on `base_port + i` on localhost), `job_memory` (by `memory`: 56G or 16G), `job_cpus` (no quota), `job_threads` (proving threads; by default cores divided by `max_concurrent`, see [Memory](#memory)), `pids_max` (1024), `sandbox` (`"cgroup"`, or `"none"` for development): see [Isolation](#isolation). |
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

Checked 2026-09-27: the image (`x86-64-v3`) ran its gateway as `arbiter` with
no capabilities and proved the 529-step game on a worker in 26.6 s (24.8 s
with a `native` build), and the unit's cgroup settings, as a user service,
proved the 319-step game; both proofs were byte-identical to native builds'.

## API

JSON-RPC 2.0 on `/`:
- `starknet_proveTransaction { block_id, transaction }` returns
  `{ proof, proof_facts, l2_to_l1_messages }`, as the hosted prover does;
- `starknet_specVersion` is the backend's version;
- `arbiter_info` returns the chain, OS program, allowlisted classes, proof paths,
  memory mode, workers (ready, busy, restarts) and limits.

| Code | Meaning |
| --- | --- |
| `24` | Block not found |
| `1000` | Not a zero-fee INVOKE_V3, malformed, or calldata too large (settle in checkpoints) |
| `1100` | Sender is not an allowlisted arbiter adapter |
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
to it. `arbiter_adapter` already accepts PROOF2 facts. If PROOF2 proofs attest
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
