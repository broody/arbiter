# referee prover

Self-hosted native proofs for referee games. `@referee/sdk/proving` sends a
session's settlement to a `starknet_proveTransaction` endpoint. By default that
is StarkWare's hosted alpha prover; this directory runs the same endpoint
yourself:

| Process | What it is |
| --- | --- |
| backend | StarkWare's `starknet_transaction_prover` (the service behind the hosted prover), built from source at the sequencer revision in [`pins.json`](pins.json), with referee's [memory patches](#memory). It runs the adapter's virtual transaction in the virtual OS and proves it with Stwo in process. **PROOF1.** |
| gateway | [`server.mjs`](server.mjs): the same JSON-RPC API in front of the backend. It admits only referee settlements (below), queues and rate-limits them, and maps capacity errors. |

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
back between proofs on a shared host. Budget per concurrent job about 40 GiB
in `standard` (46 once a long-running backend has proved games of mixed sizes)
and 22 GiB in `bounded`, plus headroom: the backend is one process, so a job
over budget is OOM-killed together with every other job in it. On the 125 GiB
machine below, with copies of the largest game started together in one
backend:

| `memory` | `max_concurrent` | Peak | Seconds per proof |
| --- | ---: | ---: | ---: |
| `standard` | 1 | 39.5 GiB | 23 |
| `standard` | 2 | 70.7 GiB | 23 |
| `bounded` | 1 | 21.8 GiB | 43 |
| `bounded` | 3 | 56.5 GiB | 31 |
| `bounded` | 4 | 67.1 GiB | 29 |

(Wall time divided by proofs, OS run included.) A second `standard` slot adds
no throughput here; it lets one job's OS run, which waits on the RPC node,
overlap another's proof. `bounded` gains from concurrency because one bounded
proof does not keep every core busy. On this machine: `standard` with
`max_concurrent: 2`.

**Allocator.** `run.sh` starts the backend with a fixed 1 MiB glibc mmap
threshold (`MALLOC_MMAP_THRESHOLD_`) in both modes. Without it, freed proving
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
sequencer patch adds the backend's settings, which `run.sh` sets from `memory`:

| Variable | Meaning |
| --- | --- |
| `PROVER_LOW_MEMORY=1` | Per-proof trees and buffer pools, nothing shared between proofs. |
| `PROVER_BOUNDED_CAIRO_COLUMNS`, `PROVER_BOUNDED_CIRCUIT_COLUMNS` | `N > 0`: coefficients instead of expanded columns, FRI quotients `N` columns at a time. Require `PROVER_LOW_MEMORY=1`. |
| `PROVER_RECOMPUTE_CAIRO_COMMITMENTS`, `PROVER_CAIRO_COEFFICIENTS` | Low-memory details, default 1. |

Moving to a new sequencer revision means regenerating the patches against the
revisions its lockfile pins; `build.sh` refuses a mismatch.

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
| `backend_url` | Where the backend listens. Keep it on localhost. |
| `virtual_os_program` | The program adapters pin and the backend runs (`pins.json`). |
| `adapter_classes` | Allowlisted adapter class hashes. |
| `max_concurrent`, `max_queued` | Proofs in parallel (the backend gets the same limit; see [Memory](#memory) for the budget) and waiting requests. |
| `memory` | `standard` (default) or `bounded`: see [Memory](#memory). |
| `prefetch_state` | Fetch the transaction's state up front with one simulation (default true). |
| `max_calldata`, `rate_per_minute`, `backend_timeout_ms` | Request size, per-client rate and backend timeout. |

```bash
prover/run.sh my-config.json
```

`run.sh` starts the backend on `backend_url`, waits for it, then runs the
gateway. The gateway logs one JSON line per request (client, sender, block,
calldata size, outcome, time). `GET /health` answers `ok`.

## API

JSON-RPC 2.0 on `/`:
- `starknet_proveTransaction { block_id, transaction }` returns
  `{ proof, proof_facts, l2_to_l1_messages }`, as the hosted prover does;
- `starknet_specVersion` is the backend's version;
- `referee_info` returns the chain, OS program, allowlisted classes, proof paths,
  memory mode and limits.

| Code | Meaning |
| --- | --- |
| `24` | Block not found |
| `1000` | Not a zero-fee INVOKE_V3, malformed, or calldata too large (settle in checkpoints) |
| `1100` | Sender is not an allowlisted referee adapter |
| `1101` | The adapter pins another virtual OS program |
| `1102` | The transaction exceeds PROOF1; settle in checkpoints |
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
backend; `scripts/check.sh` includes it. [`measure.sh`](measure.sh) starts a
backend in its own cgroup, runs any client against it, and reports peak memory
and the backend's OS-run and proof times.
