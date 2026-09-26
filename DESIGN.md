# Referee design

Status: **draft, 2026-09-26**. The core crate, the JS SDK mirror and the counter
example are built and tested. Everything marked *planned* is not.

Referee lets two players play a turn-based game offchain with signed moves and
settle the result on Starknet. There is no transaction per move. A game supplies
its rules once, in Cairo. The same code validates moves in clients, replays
disputes onchain, and runs inside the Stwo proof that settles the game.

It is extracted from Surround (`~/development/surround`, Go) and generalized for
Hashfront (`~/development/hashfront`, a tactics game with combat randomness).

## Layers

| Layer | Status | Depends on | Purpose |
|---|---|---|---|
| `core` (Cairo) | built | nothing | `GameRules`, protocol envelope, hashing, signatures, replay, forced steps, randomness |
| channel state machine (Cairo) | planned | `core` | Pure functions: open, join, receive a candidate, dispute, resolve, force, timeout, resume, resign |
| `referee_dojo` (Cairo) | planned | `core`, Dojo | Models, events and `WorldStorage` helpers. Games list its models in `build-external-contracts` |
| adapter template (Cairo 2.18) | planned | `core` | SNIP-36 account contract that proves a replay in the virtual OS and relays it to the channel |
| `sdk` (JS) | hashing and replay built | starknet.js | Signing, transcripts, randomness chains, fixtures; later transaction and proof builders |
| relay, keeper | planned | `sdk` | Move transport and archive; prove, settle and answer disputes |

`core` has no Dojo or storage dependency and builds on both Cairo 2.13 (Dojo)
and 2.18 (the adapter). `scripts/check.sh` tests both.

## The game interface

```cairo
pub trait GameRules {
    type Config;   // terms bound into the context (board size, map hash)
    type State;
    type Action;
    type Witness;  // extra replay input from calldata (position history, map terrain)
    type Scratch;  // working memory built from the witness (e.g. Felt252Dict)
    const TAG: felt252;
    const RULES_VERSION: u32;
    const SEATS: u8;   // 2 for now
    fn init(config: @Config) -> State;
    fn load(config: @Config, state: @State, witness: Witness) -> Scratch;
    fn apply(config: @Config, ref scratch: Scratch, state: State, seat: u8, action: Action)
        -> (State, Option<u8>);          // Some(seat) = that seat must reveal randomness
    fn resolve(config: @Config, ref scratch: Scratch, state: State, seed: felt252) -> State;
    fn due(state: @State) -> u8;
    fn outcome(state: @State) -> Option<(u8, u8)>;   // (seat + 1 or DRAW, reason 1..=127)
}
```

Rules must be deterministic and must panic on illegal actions.
`examples/counter` is a complete game in about 100 lines.

| | Surround | Hashfront |
|---|---|---|
| Config | size, komi | map id, map hash |
| State | bitboards, scoring phase, captures | units, buildings, gold, round, stat counters |
| Action | play, pass, propose, accept, resume | move, attack, capture, build, end turn |
| Witness / Scratch | position history / superko `Felt252Dict` | packed terrain grid / terrain lookup |
| Randomness | never | ATTACK returns `Some(defender)` |

## Protocol

**Envelope.** The library wraps the game state:
`Envelope { seq, transcript, support_turn, last_seat, pending, rng_heads, outcome, game }`.

**Moves.** `Move<A>` is `Play(A)`, `Reveal`, `Recommit` or `Resign`. Every game
gets the last three for free. A `Step` is `{ seat, action, entropy }`.

**Messages.** A step's message is
`signing_hash(TAG, 'REFEREE_ACTION_V1', context, seq, transcript, step)`.
- It binds the transcript, not the full state. State is determined by the
  anchor plus the transcript, and hashing a large state on every step is costly
  to prove.
- `transcript' = poseidon(transcript, message)`.
- Checkpoint and reopen approvals sign the state hash with an epoch.
- All digests are domain-separated by the game's `TAG` and a
  `REFEREE_*_V1` tag, and masked to 250 bits for STARK-curve ECDSA.

**Context.** The context hash covers `Terms<Config>`: chain id, channel, game id,
prover, response window, and per-seat wallets, session keys and randomness-chain
tips, plus the game config.

**Final-signature authentication** (from Surround). `replay` verifies only each
seat's last signature in a batch; that signature covers the seat's earlier steps
through the transcript. Clients must verify every step they receive and never
sign from an unverified state. The test
`tampered_earlier_step_breaks_final_signature` covers this.

**Signer changes.** `support_turn` counts changes of signer. It ranks dispute
candidates, so consecutive self-signed steps never outrank a branch the opponent
acknowledged.

**Randomness.**
- Each seat commits the tip of a hash chain (`rng_next(v) = poseidon('REFEREE_RNG_V1', v)`).
- When `apply` requests randomness, the actor must attach its next chain value
  as `entropy`. The named seat then sends `Reveal`, and the game gets
  `seed = poseidon(TAG, 'REFEREE_SEED_V1', context, seq, requester, revealer)`.
- Neither seat can predict the seed before the second reveal, and neither can
  bias it.
- Withholding a reveal only stalls, and a stall ends in a forced reveal or a
  timeout.
- `Recommit` replaces the due seat's tip before its chain runs out. It is
  impossible while a reveal is pending.

**Replay and force.**
- `replay` applies signed steps from an anchor.
- `force` applies unsigned steps for callers that authenticate the seat
  themselves, such as a forced onchain turn checked against the wallet caller.
- Both extend the transcript identically.

## Channel (planned)

This is Surround's state machine, generalized.
- **Statuses:** WAITING, ACTIVE, DISPUTE, FORCED, SETTLED, CANCELLED. `epoch`
  increments on every commit.
- **Committing:** a state commits only when proved (adapter) or replayed onchain
  (`submit_history`), from the stored anchor. With all approvals it commits at
  once. Without them it becomes a candidate and opens a dispute window.
  Signatures alone never commit a state, because colluding seats could sign
  fabricated results.
- **Disputes:**
  - candidates replay from the frozen anchor and rank by `(support_turn, seq)`;
  - a late candidate never extends the deadline;
  - `resolve` promotes the candidate to SETTLED, or to FORCED with a fresh window.
- **Forced play:** the due seat submits its steps up to the next change of due
  seat in one transaction (`force`). Surround allows one step per transaction.
- **Endings:** `claim_timeout` after a missed window, `resume` with every seat's
  reopen approval, and `resign` at any time.
- **Storage:** anchors and candidates are stored as hashes, with preimages in calldata.
- **Settlement:** writes the winner, the reason and the game's outputs, and
  emits an event for rewards.
- **v0 simplifications:** a single owner account, upgradeable through Dojo, an
  owner-set allowlist of adapter class hashes, and settlement and rewards in the
  same game system.

## Proving strategy

- **Whole game in one proof when it fits.** Final-signature authentication and
  transcript binding keep traces small. Surround's 311-action v3 game is
  1.57M trace instructions.
- **Checkpoint proofs otherwise.** Each proves a segment from the committed
  anchor and commits it onchain. This works with PROOF1 today, and PROOF2 only
  reduces how many are needed.
- **No per-move recursive proving:**
  - STARK proof size barely grows with trace length: Surround's 68-action proof
    is 233 KB and its 311-action proof is about 251 KB.
  - Onchain verification is a roughly flat charge per proof (`gas_per_proof`
    ≈ 75M L2 gas).
  - So a recursive chain would end with a proof of about the same size and
    cost, while every link would also have to verify the previous proof inside
    Cairo, which is far more work than a move.
- **Aggregation across games** is the recursion that pays: many settled games
  per proof to spread the fixed charge. It is a later optimization.

## Roadmap

1. Channel state machine as pure functions, ported from Surround's
   `src/systems/channel.cairo`, with tests on the counter game.
2. `referee_dojo` binding, plus a counter Dojo system on Katana.
3. Adapter template, and an end-to-end native proof of a counter game.
4. Port Surround onto referee, keeping its test suites, and re-measure proofs.
5. Hashfront rules crate and client integration.
6. Relay, keeper, and SDK transaction and proof builders.

## Development

```bash
scripts/check.sh    # regenerate fixtures, fmt check, test on Cairo 2.13.1 and 2.18.0
```

The counter fixtures are produced by the JS SDK (`sdk/scripts/gen-counter-fixtures.mjs`),
so the Cairo tests check the two implementations against each other.
