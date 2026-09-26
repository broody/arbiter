# Referee design

Status: **draft, 2026-09-26**. Built and tested: the core crate (protocol and
channel state machine), the Dojo binding, the JS SDK mirror, and the counter
example as both a pure game and a Dojo world. Everything marked *planned* is not.

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
| channel state machine (`referee::channel`) | built | `core` | Pure functions: create, join, receive a candidate, dispute, resolve, forced play, timeout, resume, resign |
| `referee_dojo` (Cairo) | built | `core`, Dojo | `ChannelGame`/`ProverAllowed` models, `ChannelUpdated` event and one helper per entrypoint. Games list the models in `build-external-contracts` |
| `referee_testing` (Cairo) | built | `core` | Test-only STARK-curve signer and hash-chain helper |
| `referee_adapter` (Cairo 2.18) | built, tested with mocked proof facts | `core` | Generic logic for a SNIP-36 account contract that proves a replay in the virtual OS and relays it to the channel |
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

**Moves.** A step is a `Move<A>`:

| Move | Payload | Seat |
| --- | --- | --- |
| `Play(A)` | the game action | the due seat |
| `PlayRandom((A, entropy))` | an action whose `apply` requests randomness, and the actor's next chain value | the due seat |
| `Reveal(value)` | the named seat's next chain value | the seat the pending request names |
| `Recommit(tip)` | a new chain tip | the due seat |
| `Resign(seat)` | the resigning seat | named, since either seat may resign at any time |

Every game gets the last four for free. The seat is implied by the state
(`actor`), so only `Resign` carries one, and only `PlayRandom` carries entropy.
`Play` of an action that requests randomness fails with `'Randomness requested'`,
and `PlayRandom` of one that doesn't fails with `'Unexpected entropy'`. A
Surround Go stone is 3 felts of calldata; in v1 it was 10 (`{ seat, action,
entropy }` with a fixed-width action, plus a signature per step).

**Messages.** A step's message is
`signing_hash(TAG, 'REFEREE_ACTION_V1', context, seq, transcript, move)`.
`PROTOCOL_VERSION` 2 is in the context hash, so v1 signatures never verify
under v2.
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

**Final-signature authentication** (from Surround). `replay` takes a batch of
moves and exactly one signature per seat: that seat's last signature in the
batch, or a zero signature if the seat has no step in it. A seat's last
signature covers all of its earlier steps through the transcript, so
intermediate signatures never reach calldata or the proof. Clients still verify
and keep every signature they receive (`Session` does) and never sign from an
unverified state. The tests `tampered_earlier_step_breaks_final_signature`,
`intermediate_signature_is_not_a_final_one` and
`seat_without_steps_signs_nothing` cover this.

**Signer changes.** `support_turn` counts changes of signer. It ranks dispute
candidates, so consecutive self-signed steps never outrank a branch the opponent
acknowledged.

**Randomness.**
- Each seat commits the tip of a hash chain (`rng_next(v) = poseidon('REFEREE_RNG_V1', v)`).
- When `apply` requests randomness, the actor sends `PlayRandom` with its next
  chain value as `entropy`. The named seat then sends `Reveal`, and the game gets
  `seed = poseidon(TAG, 'REFEREE_SEED_V1', context, seq, requester, revealer)`.
- Neither seat can predict the seed before the second reveal, and neither can
  bias it.
- Withholding a reveal only stalls, and a stall ends in a forced reveal or a
  timeout.
- `Recommit` replaces the due seat's tip before its chain runs out. It is
  impossible while a reveal is pending.

**Replay and force.**
- `replay` applies moves from an anchor against each seat's final signature.
- `force` applies unsigned moves that must all belong to one seat, for callers
  that authenticate that seat themselves, such as a forced onchain turn checked
  against the wallet caller.
- `apply_steps` applies unsigned moves from any seat, for clients and tests
  that already verified every signature.
- All three extend the transcript identically.

## Channel

This is Surround's state machine, generalized, as pure functions in
`referee::channel` (`examples/counter/src/channel_tests.cairo`).
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

## Dojo binding

A game's whole channel system is one line per entrypoint
(`dojo/examples/counter/src/lib.cairo`):

```cairo
fn join(ref self: ContractState, game_id: felt252, session_key: felt252, rng_tip: felt252) {
    let mut world = self.world_default();
    binding::join::<CounterRules>(ref world, game_id, session_key, rng_tip);
}
```

- The game adds `referee_dojo::models::{m_ChannelGame, m_ProverAllowed, e_ChannelUpdated}`
  to `build-external-contracts`, and `sozo` registers them in the game's namespace.
- `ChannelGame` stores 2 seats (wallet, session key, randomness tip), the prover,
  the serialized game `Config`, the `Channel` fields and the result.
- Callers are authenticated by wallet for create, join, cancel, dispute, forced
  play, timeout and resign. `submit_history` and `resolve` are open to anyone, for
  example a keeper. `accept_verified` accepts only the game's prover.
- `allow_prover` lets namespace owners allowlist adapter classes.
- Rewards read `binding::result(world, game_id)` once a game is SETTLED.

## Proof adapter

`adapter/referee_adapter` holds the logic, and a game's adapter is an
immutable `#[starknet::contract(account)]` of about 40 lines
(`adapter/examples/counter/src/lib.cairo`) that pins the virtual OS program in
its constructor.

- **`__execute__` (virtual).** A zero-fee INVOKE_V3 that is never broadcast. It:
  - reads the channel's `snapshot`;
  - checks the start state against the anchor hash;
  - replays the signed steps with the game's rules;
  - emits one L2→L1 message: adapter class, `TAG`, `'REFEREE_PROVED_V1'`,
    chain, adapter, channel, game, context, epoch, start hash, end hash.

  A prover proves this execution.
- **`settle` (real).** A transaction with the proof attached. `settle` checks the
  network-verified proof facts:
  - PROOF1 or PROOF2;
  - the virtual SNOS program pinned at deployment;
  - a base block at or after the anchor and at most 4000 blocks old;
  - exactly one message equal to the expected transition.

  It then calls the channel's `accept_verified`.
- **No typed interface per game.** The adapter reaches the channel through
  raw syscalls (`snapshot`, `accept_verified`), so it works with any
  referee_dojo game system.

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

1. ~~Channel state machine as pure functions.~~ Done.
2. ~~`referee_dojo` binding and a counter Dojo system.~~ Done
   (`dojo/examples/counter`, tested in a Dojo test world).
3. ~~Adapter logic (`adapter/referee_adapter`) and a counter adapter.~~ Done,
   tested with snforge-mocked proof facts. Still to do: an end-to-end native
   proof of a counter game against a real prover.
4. Port Surround onto referee, keeping its test suites, and re-measure proofs.
5. Hashfront rules crate and client integration.
6. Relay, keeper, and SDK transaction and proof builders.

## Development

```bash
scripts/check.sh    # regenerate fixtures, fmt check, test on Cairo 2.13.1 and 2.18.0
```

The counter fixtures are produced by the JS SDK (`sdk/scripts/gen-counter-fixtures.mjs`),
so the Cairo tests check the two implementations against each other.
