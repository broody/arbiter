# Referee design

Status: **draft, 2026-09-27**. Built and tested: the core crate (protocol,
optional referee clocks and channel state machine), the Dojo binding, the JS
SDK mirror, and the counter example as both a pure game and a Dojo world.
Everything marked *planned* is not.

Referee lets two players play a turn-based game offchain with signed moves and
settle the result on Starknet. There is no transaction per move. A game supplies
its rules once, in Cairo. The same code validates moves in clients, replays
disputes onchain, and runs inside the Stwo proof that settles the game.

It is extracted from Surround (`~/development/surround`, Go) and generalized for
Hashfront (`~/development/hashfront`, a tactics game with combat randomness).

## Layers

| Layer | Status | Depends on | Purpose |
|---|---|---|---|
| `core` (Cairo) | built | nothing | `GameRules`, protocol envelope, hashing, signatures, replay, forced steps, randomness, referee clocks |
| channel state machine (`referee::channel`) | built | `core` | Pure functions: create, join, receive a candidate, dispute, resolve, forced play, timeout, resume, resign |
| `referee_dojo` (Cairo) | built | `core`, Dojo | `ChannelGame`/`ProverAllowed` models, `ChannelUpdated` event and one helper per entrypoint. Games list the models in `build-external-contracts` |
| `referee_testing` (Cairo) | built | `core` | Test-only STARK-curve signer and hash-chain helper |
| `referee_adapter` (Cairo 2.18) | built, tested with mocked proof facts | `core` | Generic logic for a SNIP-36 account contract that proves a replay in the virtual OS and relays it to the channel |
| `sdk` (JS) | built | starknet.js | Signing, transcripts, randomness chains, clocks and `Referee`, fixtures; native proving client (`@referee/sdk/proving`); session store and signing guard (`@referee/sdk/store`) |
| keeper (`keeper/`) | built, tested on Katana | `sdk` | Archives and forwards verified steps, records equivocation, answers disputes, resolves and settles |

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
`Envelope { seq, transcript, support_turn, last_seat, pending, rng_heads, clock, outcome, game }`.

**Moves.** A step is a `Move<A>`:

| Move | Payload | Seat |
| --- | --- | --- |
| `Play(A)` | the game action | the due seat |
| `PlayRandom((A, entropy))` | an action whose `apply` requests randomness, and the actor's next chain value | the due seat |
| `Reveal(value)` | the named seat's next chain value | the seat the pending request names |
| `Recommit(tip)` | a new chain tip | the due seat |
| `Resign(seat)` | the resigning seat | named, since either seat may resign at any time |
| `Flag` | nothing | the referee of a timed game (`REFEREE`), once the due seat's time ran out |

Every game gets the last five for free. The seat is implied by the state
(`actor`), so only `Resign` carries one, and only `PlayRandom` carries entropy.
`Play` of an action that requests randomness fails with `'Randomness requested'`,
and `PlayRandom` of one that doesn't fails with `'Unexpected entropy'`. A
Surround Go stone is 3 felts of calldata; in v1 it was 10 (`{ seat, action,
entropy }` with a fixed-width action, plus a signature per step).

**Messages.** A step's message is
`signing_hash(TAG, 'REFEREE_ACTION_V1', context, seq, transcript, move)`.
`PROTOCOL_VERSION` 3 is in the context hash, so older signatures never
verify under it.
- It binds the transcript, not the full state. State is determined by the
  anchor plus the transcript, and hashing a large state on every step is costly
  to prove.
- `transcript' = poseidon(transcript, message)`.
- Checkpoint and reopen approvals sign the state hash with an epoch.
- All digests are domain-separated by the game's `TAG` and a
  `REFEREE_*_V1` tag, and masked to 250 bits for STARK-curve ECDSA.

**Context.** The context hash covers `Terms<Config>`: chain id, channel, game id,
prover, response window, time control (`None` for an untimed game), and per-seat
wallets, session keys and randomness-chain tips, plus the game config.

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

**Clocks** (optional, per game). `Terms.clock` is an
`Option<TimeControl { referee, turn_ms, bank_ms, increment_ms }>`. Players sign
moves; the referee signs time.
- **Stamps.** The referee stamps every offchain step with its own clock, in
  milliseconds, and after each step signs
  `signing_hash(TAG, 'REFEREE_STAMP_V1', context, seq, transcript, clock)`.
  Stamps stay out of the transcript, so a seat's signature never waits on the
  referee: a seat signs the rest of its turn from its `tip` while earlier steps
  wait in `pending` for their stamps.
- **Charging.** `Envelope.clock` is `Option<Clock { banks, turn, stamp }>`. A
  step charges the time since the last stamp to the seat on the clock (`due`):
  the turn's allowance first, then its bank.
  - A turn is a run of steps while `GameRules::due` stays the same. When it
    changes, the finished turn's seat gains `increment_ms` and the next turn
    starts with `turn_ms`.
  - A pending reveal is timed on its own, with a fresh `turn_ms`, so
    withholding a reveal burns the revealer's clock.
- **Flags.** A step after the seat's time ran out fails with `'Flag fell'`. The
  referee's `Flag` is valid only then, and the due seat loses with
  `REASON_TIMEOUT`. Resign, flag and `claim_timeout` share `forfeit`, the one
  place a protocol with more seats would turn into an elimination.
- **Replay.** `replay` takes a `Batch { steps, stamps, signatures, attestation }`.
  The referee's last attestation covers every stamp, since the clocks depend on
  all of them, so one attestation reaches calldata. An untimed batch has no
  stamps and a zero attestation. The tests `timed_replay_matches_sdk`,
  `intermediate_attestation_is_not_a_final_one` and
  `tampered_stamp_breaks_the_attestation` cover this.
- **Pauses.** An unstamped step (onchain `force`) pauses the clock, and the next
  stamp restarts it without charging anyone. A timed game reaches FORCED only
  when the referee is down, since a live referee flags a staller inside the
  dispute window. Forced play therefore runs untimed, on the channel's windows.
- **Channel.** Unchanged: a flag is a finished history like any other, and the
  flagged seat cannot outrank it without the referee attesting a competing
  branch.
- **Trust.** The referee cannot forge, reorder or settle anything. It can skew
  time or censor, so an honest seat's worst case is losing on time. Two
  attestations at one seq with different transcripts are evidence of
  equivocation. Each game opts in: the referee's key is in the terms, which
  both seats accept by joining.
- **Settings.** Surround's old per-turn clock is `turn_ms` 60 s and no bank;
  blitz 3+2 is `bank_ms` 180 s and `increment_ms` 2 s; Hashfront's turn timers
  are a turn allowance plus a small bank. Each setting is at most 30 days.
- **Cost.** An untimed game adds 1 felt to the terms and the envelope and 3
  felts per replay. A timed game adds 1 felt per step, the clock to the
  envelope, and one ECDSA check per replay or proof.
- **`Referee`** (`@referee/sdk`) stamps steps as they arrive, flags, and
  reports the `deadline()` for a timer. Its time resumes at the last stamp when
  it is made, so a restarted referee never charges seats for its own downtime.

**Replay and force.**
- `replay` applies moves from an anchor against each seat's final signature
  and, in a timed game, the referee's final attestation.
- `force` applies unsigned moves that must all belong to one seat, for callers
  that authenticate that seat themselves, such as a forced onchain turn checked
  against the wallet caller. Its steps are unstamped.
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
  the time control, the serialized game `Config`, the `Channel` fields and the
  result.
- `create` takes an `Option<TimeControl>`. A referee key must be a curve point
  and neither seat's session key.
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
- **Calldata convention.** A game's adapter declares
  `__execute__(channel, game_id, epoch, start, witness, batch)`
  (no `witness` argument when the game's witness is `()`) and
  `settle(channel, game_id, epoch, end, acks)`, which is what the JS proving
  client builds.

**JS proving client** (`@referee/sdk/proving`), for any game:
- `proveSession({ rpcUrl | provider, proverUrl, session, epoch, expectedClassHash })`
  waits until the channel anchor is 10 blocks deep, checks that the session
  starts at the anchor under the current epoch and that the prover is the
  expected class, replays the session with every signature verified, sends the
  adapter's virtual transaction to a `starknet_proveTransaction` prover, and
  checks the response (`validateNativeProof`). It returns the transaction
  options with the proof and a `call(acks)` builder for `settle`.
- `provingTransaction`, `provingCalldata`, `settlementCall`, `getSnapshot` and
  `nativeProofBlock` are exported for callers that drive the steps themselves.
- A game with a replay witness adds `encodeWitness(witness)` to its codec.

## Client persistence

**Signing guard.** A seat that signs two different steps at one seq has
equivocated: the other seat holds both branches and can settle whichever suits
it. The usual cause is a client restored from a stale copy (a backup, a second
tab, a lost write) that signs again below its last step.
- `Session.lastSigned[seat]` is the record of the last step the client signed
  for that seat. `sign` and `move` refuse unless the session's history
  includes it:
  - at the mark's seq, only the identical step, which re-signs to the same
    signature;
  - past it, only if the history contains the marked step;
  - behind it, nothing until the missing steps arrive.
- A mark before the session's anchor is superseded by the anchor.
- Marks are opt-in. A `Session` without them behaves as before, so tests can
  still build forks.

**Session store** (`@referee/sdk/store`). `SessionStore` keeps transcripts,
marks and session keys in a backend: `indexedDbBackend` for browsers,
`fileBackend` (`@referee/sdk/store/file`) for Node, `memoryBackend` for tests.
- `move` checks the stored mark, signs, and records the new mark in one atomic
  update before it returns the signed step, so two tabs cannot both sign at one
  seq.
- Marks are stored apart from transcripts, so restoring an old transcript never
  rolls one back.
- `load` re-verifies the transcript (`Session.import`) and re-applies a marked
  step that never reached it.
- `save` refuses to overwrite a transcript it does not extend.
- `saveKey` keeps a session key, with the seat's randomness seed, under its
  public key; `keyFor(terms)` finds the seat.
- The guard is per store. Two devices holding one key do not share marks, so a
  key is used on one device at a time. The file backend locks its directory to
  one process.
- In a timed game `move` signs the step without applying it: it joins
  `session.pending` until the referee's stamped record comes back through
  `receive`. The mark keeps the whole pending chain, so `load` restores it for
  the client to resend (`KeeperClient.submit`). A different step landing first
  at a pending step's seq (a flag, or the other seat resigning) drops the
  chain. A failed write discards the step it signed, so that signature never
  leaves.

## Keeper

`keeper/` is one service that archives moves, answers disputes and settles
(see [keeper/README.md](keeper/README.md)). The two jobs share one state: the
latest verified transcript.
- **Trust.** The keeper's trust model is the prover gateway's. It keeps only
  steps that verify, so it cannot forge one. It can delay or withhold steps,
  but both players keep their own copies. It holds no player keys: its own
  account sends only `submit_history`, `resolve` and the adapter's `settle`,
  which anyone may send.
- **Archive.** A game is admitted when its context matches the one the
  channel stores. Where two branches meet, the one that ranks higher as a
  dispute candidate is kept. Two different steps one seat signed at one seq
  are stored as equivocation evidence.
- **Transport.** Clients (`@referee/sdk/keeper`) register a session, send
  steps and long-poll for the other seat's. They verify every step they pull,
  and `pull` refuses a branch that diverges from their own.
- **Watcher.** It answers a dispute whose candidate the archive outranks,
  replaying from the channel's anchor (`rebase`). It resolves once the window
  passes, and submits finished games still ACTIVE. Up to `max_history_steps`
  steps go onchain through `submit_history`; longer transcripts are proved.
  Forced play and timeouts need a player's wallet, so it leaves them alone.
- **Channel reads.** A game system exposes `get_channel(game_id)`, which
  returns the `ChannelGame` model, decoded by the SDK's `getChannel`.
- **Referee.** With a referee key, the keeper referees the timed games whose
  terms name that key. The relay is where steps first arrive, so it is where
  they are stamped.
  - Unstamped steps are stamped on arrival (`Archive.append`), and a timer
    flags the due seat at its `deadline()`. The watcher then settles the
    flagged game like any finished one.
  - A late step is refused (`'Flag fell'`) and the seat flagged.
  - It never stamps a second step at one seq, so it attests one branch.
  - On restart it resumes each clock at its last stamp.
  - A keeper that is not the game's referee accepts only stamped steps.
  - This role is trusted, unlike the rest of the keeper: a delay costs the
    delayed seat clock time, and seats cannot route around it.
- **Tests.** `keeper/katana.sh` runs the keeper on a local Katana with the
  counter world. It answers a stale dispute and resolves it into forced play,
  settles a finished game through the dispute window to SETTLED, and referees
  a timed game, flagging the stalling seat and settling the flag.

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
6. ~~SDK proof builders.~~ Done (`@referee/sdk/proving`).
7. ~~Self-hosted PROOF1 prover.~~ Done (`prover/`: upstream transaction prover
   plus an allowlisting gateway). PROOF2 large path once the network accepts it.
8. ~~Keeper.~~ Done: `@referee/sdk/store` persists sessions and guards
   signing, and `keeper/` archives and forwards steps and answers disputes,
   resolves and settles (tested on Katana). Still to do: the proof path against
   a live prover, and cooperative checkpoint approvals (`acks`) through the
   keeper.
9. ~~Referee clocks.~~ Done: optional per-game time controls, referee stamps
   and flags in core, the SDK (`Referee`) and the keeper (tested on Katana).
   Still to do: a websocket or SSE transport for bullet time controls, and a
   referee bond that equivocation evidence can slash.
10. More than 2 seats: endings as eliminations (`forfeit`), an outcome with
    teams or placements, randomness that two colluding seats cannot predict,
    and joining N seats.

## Development

```bash
scripts/check.sh    # regenerate fixtures, fmt check, test on Cairo 2.13.1 and 2.18.0
```

The counter fixtures are produced by the JS SDK (`sdk/scripts/gen-counter-fixtures.mjs`),
so the Cairo tests check the two implementations against each other.
