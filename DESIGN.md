# Referee design

Status: **draft, 2026-09-30**. Built and tested: the core crate (protocol,
optional referee clocks, randomness from the referee and channel state
machine), the Dojo binding, the JS SDK mirror, and the counter example as both
a pure game and a Dojo world.
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
| channel state machine (`referee::channel`) | built | `core` | Pure functions: create, join, receive a candidate, dispute, acknowledge, resolve, forced play, a posted roll, void, timeout, resume, resign |
| `referee_dojo` (Cairo) | built | `core`, Dojo | `ChannelTerms`/`ChannelState`/`ProverAllowed` models, `ChannelUpdated` event and one helper per entrypoint, including `acknowledge`, `resume_by_referee`, `roll` and `void`. Games list the models in `build-external-contracts` |
| `referee_testing` (Cairo) | built | `core` | Test-only STARK-curve signer and hash-chain helper |
| `referee_adapter` (Cairo 2.18) | built, tested with mocked proof facts | `core` | Generic logic for a SNIP-36 account contract that proves a replay in the virtual OS and relays it to the channel |
| `sdk` (JS) | built | starknet.js | Signing, transcripts, randomness chains, clocks and `Referee`, fixtures, Poseidon in WebAssembly; native proving client (`@referee/sdk/proving`); session store and signing guard (`@referee/sdk/store`) |
| keeper (`keeper/`) | built, tested on Katana | `sdk` | Archives and forwards verified steps, records equivocation, answers disputes, resolves and settles, referees timed games and gives them their randomness |

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
    impl Time: ClockRules<State>;   // how its clocks run when timed, e.g. StandardTime<State>
    fn init(config: @Config) -> State;
    fn load(config: @Config, state: @State, witness: Witness) -> Scratch;
    fn apply(config: @Config, ref scratch: Scratch, state: State, seat: u8, action: Action)
        -> (State, Option<u8>);          // Some(seat) = that seat must reveal randomness
    fn resolve(config: @Config, ref scratch: Scratch, state: State, seed: felt252) -> State;
    fn due(state: @State) -> u8;
    fn outcome(state: @State) -> Option<(u8, u8)>;   // (seat + 1 or DRAW, reason 1..=127)
    fn max_steps(config: @Config) -> u32;            // transcript cap; see below
    fn adjudicate(config: @Config, state: @State) -> (u8, u8);   // the result at the cap
}
```

Rules must be deterministic and must panic on illegal actions. A game bounds
its own length in `outcome` (a move or round limit), so every game ends.
`max_steps` is a safety net on top: the protocol ends a game with
`adjudicate` at the first step at or past it that leaves no reveal pending. It
bounds transcripts, proofs and keeper archives even for a game with a bug in
its own limit, so set it to at least the game's longest game times (1 +
protocol steps per game action).
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
`Envelope { seq, transcript, support_turn, last_seat, pending, rng_heads, rng_fresh, rng_referee, clock, outcome, game }`.

**Moves.** A step is a `Move<A>`:

| Move | Payload | Seat |
| --- | --- | --- |
| `Play(A)` | the game action | the due seat |
| `PlayRandom((A, entropy))` | an action whose `apply` requests randomness, and the actor's next chain value | the due seat |
| `Reveal(value)` | the named seat's next chain value, or the referee's | the seat the pending request names, or the referee in a game that takes its randomness from it |
| `Recommit(tip)` | a new chain tip | the due seat, once per reveal |
| `Resign(seat)` | the resigning seat | named, since either seat may resign at any time |
| `Flag` | nothing | the referee of a timed game (`REFEREE`), once the due seat's time ran out |
| `Start` | nothing | the referee of a timed game, to start or restart its clock |

Every game gets every move but `Play` and `PlayRandom` for free. The seat is implied by the state
(`actor`), so only `Resign` carries one, and only `PlayRandom` carries entropy.
`Play` of an action that requests randomness fails with `'Randomness requested'`,
and `PlayRandom` of one that doesn't fails with `'Unexpected entropy'`. A
Surround Go stone is 3 felts of calldata; in v1 it was 10 (`{ seat, action,
entropy }` with a fixed-width action, plus a signature per step).

**Messages.** A step's message is
`signing_hash(TAG, 'REFEREE_ACTION_V1', context, seq, transcript, move)`.
`PROTOCOL_VERSION` 5 is in the context hash, so older signatures never
verify under it.
- It binds the transcript, not the full state. State is determined by the
  anchor plus the transcript, and hashing a large state on every step is costly
  to prove.
- `transcript' = poseidon(transcript, message)`.
- Checkpoint and reopen approvals sign the state hash with an epoch. The
  referee of a timed game signs `live_hash(context, epoch, deadline)` to show
  it is live during a dispute, and `referee_resume_hash(context, epoch, state)`
  to return a game from forced play on its own. For a game that takes its
  randomness from it, the referee signs `tip_hash(chain_id, channel, game_id,
  tip)`, and the seats sign `void_hash(context, epoch, state)` to void one
  whose roll waits (see Referee randomness).
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

**Signer changes.** `support_turn` counts changes of signing seat. It ranks
dispute candidates, so consecutive self-signed steps never outrank a branch the
opponent acknowledged. The referee's steps count for neither seat.

**Randomness.**
- Each seat commits the tip of a hash chain (`rng_next(v) = poseidon('REFEREE_RNG_V1', v)`).
- When `apply` requests randomness, the actor sends `PlayRandom` with its next
  chain value as `entropy`. The named seat then sends `Reveal`, and the game gets
  `seed = poseidon(TAG, 'REFEREE_SEED_V1', context, seq, requester, revealer)`.
- Rolls happen offchain, as ordinary signed steps: there is no VRF or onchain
  beacon. The chain holds the committed tips, in the terms. Replay and proofs
  check each revealed value against its seat's chain and recompute each seed.
- Neither seat can predict the seed before the second reveal, and neither can
  bias it.
- A timed game can take its randomness from its referee instead, so no seat
  has to be online to reveal (see Referee randomness).
- Withholding a reveal only stalls, and a stall ends in a forced reveal or a
  timeout.
- `Recommit` replaces the due seat's tip before its chain runs out. It is
  impossible while a reveal is pending, and allowed only after the seat
  revealed from its current tip (`rng_fresh`), so a seat can't add steps at
  will. A game that never reveals, like Go, can't recommit at all.

**Clocks** (optional, per game). `Terms.clock` is an
`Option<TimeControl { referee, settings, rng_tip }>`: the referee's public key,
the settings of the game's time rules, serialized, and the tip of the
referee's hash chain if the game takes its randomness from it. Players sign
moves; the referee signs time.
- **Stamps.** The referee stamps every offchain step with its own clock, in
  milliseconds, and after each step signs
  `signing_hash(TAG, 'REFEREE_STAMP_V1', context, seq, transcript, clock)`.
  Stamps stay out of the transcript, so a seat's signature never waits on the
  referee: a seat signs the rest of its turn from its `tip` while earlier steps
  wait in `pending` for their stamps.
- **Turns.** `Envelope.clock` is `Option<Clock { seats, used, stamp }>`. A
  step adds the time since the last stamp to `used`, the time the current turn
  has used. A turn is a run of steps while `GameRules::due` stays the same;
  when it ends, the game's time rules settle `used` and it starts again from
  zero. A pending reveal is a turn of one step for the revealer, settled at
  once, so withholding a reveal burns the revealer's clock.
- **Time rules** (`referee::clocks::ClockRules<State>`). A game names its own
  with `GameRules::Time`. The protocol keeps the mechanics (stamps, `used`,
  turns, reveals, pauses, flags, attestations); the rules decide what a seat
  has and what a finished turn costs:
  - `check(settings)` rejects settings a game could not be played under;
  - `open(settings, seats)` gives each seat's clocks (`Clock.seats`);
  - `limit(settings, clocks, seat, state)` is the time a seat can use in a turn
    that starts now, which the protocol compares with `used`;
  - `settle(settings, clocks, seat, used, reveal, state)` gives the clocks the
    next turn starts with.

  Settings and clocks cross the interface serialized, so `Terms`, `Envelope`
  and the Dojo model are the same for every rule set. A rule set decodes them
  into its own types (`decode`, `encode`). It gets the game state, so a turn's
  time can depend on the position.
- **`StandardTime`** covers most clocks, in milliseconds, with
  `Standard { turn_ms, bank_ms, increment_ms, byoyomi }`. A turn's time comes
  from `turn_ms` first, which does not carry over, then from the seat's bank
  (main time), then from its byo-yomi periods; the bank then gains
  `increment_ms`. With `byoyomi: Some({ periods, period_ms })`, a turn that
  ends inside a period costs none, each period that runs out is lost, and the
  seat that outlasts its last period has flagged (Japanese byo-yomi).

  | Clock | Settings |
  |---|---|
  | Per-turn timer (Surround's old 60 s) | `turn_ms` |
  | Delay | `turn_ms` + `bank_ms` |
  | Fischer (blitz 3+2) | `bank_ms` 180 s + `increment_ms` 2 s |
  | Japanese byo-yomi (10 min + 5 × 30 s) | `bank_ms` 600 s + `byoyomi` 5 × 30 s |

  `examples/counter/src/hourglass.cairo` is a second rule set, where the time
  a seat uses flows to its opponent, in about 40 lines. The SDK mirrors a rule
  set as `game.time` (`standardTime` by default), with the same functions over
  decoded values, its codecs, and a `view` for `timeLeft`.
- **Flags.** A step after the seat used more than its `limit` fails with
  `'Flag fell'`. The referee's `Flag` is valid only then, and the due seat
  loses with `REASON_TIMEOUT`. Resign, flag and `claim_timeout` share
  `forfeit`, the one place a protocol with more seats would turn into an
  elimination. What running out does (lose, pass, be eliminated) is a game
  rule for that work, not a time rule.
- **Replay.** `replay` takes a `Batch { steps, stamps, signatures, attestation }`.
  The referee's last attestation covers every stamp, since the clocks depend on
  all of them, so one attestation reaches calldata. An untimed batch has no
  stamps and a zero attestation. The tests `timed_replay_matches_sdk`,
  `intermediate_attestation_is_not_a_final_one` and
  `tampered_stamp_breaks_the_attestation` cover this.
- **Pauses.** An unstamped step (onchain `force`) pauses the clock, and the next
  stamp restarts it without charging anyone. A timed game reaches FORCED only
  when the referee is down: a live referee acknowledges the dispute
  (`acknowledge`), and `resolve` returns the game to offchain play, where its
  clock keeps running. Forced play therefore runs untimed, on the channel's
  windows, and the referee returns the game from it on its own once it is back.
- **Start.** The referee's `Start` sets the clock's stamp and charges no one,
  paused or not. The keeper sends one when a game opens, so the first move is
  timed too, and one after play resumes from forced play, whose stale stamp
  would otherwise charge the forced period. Seats can't send it: replay
  authenticates referee steps only through the attestation, `force` never
  takes them, and an untimed game refuses them.
- **Channel.** Unchanged: a flag is a finished history like any other, and the
  flagged seat cannot outrank it without the referee attesting a competing
  branch.
- **Trust.** The referee cannot forge, reorder or settle anything. It can skew
  time or censor, so an honest seat's worst case is losing on time. Two
  attestations at one seq with different transcripts are evidence of
  equivocation. Each game opts in: the referee's key is in the terms, which
  both seats accept by joining. A game that also takes its randomness from the
  referee trusts it not to leak rolls (see Referee randomness).
- **Cost onchain and in proofs** (counter game, cairo-test gas):
  - untimed games pay about 12k gas per step for carrying the optional clock,
    about 120 Cairo steps, or 2% of a Surround move;
  - timed games pay about 50k gas per step with `StandardTime`, about 500 Cairo
    steps, plus 1 felt of calldata per step and one attestation check (about
    45k gas) per replay or proof. `StandardTime` reads its settings and clocks
    in place for this; decoding them fully cost 83k per step.
- **Cost offchain** (`node keeper/bench.mjs`): a stamp costs the referee about
  2.3 ms and applying a stamped step costs a client about 2.4 ms, mostly two
  signature checks at about 1.3 ms each with cached keys. Poseidon runs in
  WebAssembly (`sdk/poseidon`: starknet-crypto's `PoseidonHasher`, about 0.12 ms
  for 8 felts against 1.3 ms in starknet.js), which took a stamp from 7.3 ms.
  Through a keeper that referees the game, a step reaches the other seat's
  stream in about 11 ms (from 28 ms), with the keeper and both clients in one
  process on one machine. A save writes only the new step, so that stays flat
  through a game: about 14 ms at step 400 on the file store, which rewrote the
  whole transcript on each save and took 18 ms there.
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
  (`submit_history`), from the stored anchor or the current candidate. With all
  approvals it commits at once. Without them it becomes a candidate and opens a
  dispute window. Signatures alone never commit a state, because colluding
  seats could sign fabricated results.
- **Disputes:**
  - candidates rank by `(support_turn, seq)`;
  - a submission may start from the candidate, so a transcript longer than one
    proof arrives as a chain of segments within one window (the channel keeps
    the candidate's block; a proof must be based at or after it);
  - a late candidate never extends the deadline;
  - `resolve` settles a finished candidate. An unfinished one moves to FORCED
    with a fresh window, unless the game is timed and its referee acknowledged
    this dispute (`acknowledge`, stored as the dispute's epoch and deadline):
    then the game returns to ACTIVE.
- **Forced play:** the due seat submits its steps up to the next change of due
  seat in one transaction (`force`). Surround allows one step per transaction.
  A step that asks the referee for a roll pauses forced play for up to 3 days:
  no seat is due until the roll is posted (`rolled`).
- **Endings:** `claim_timeout` after a missed window (`REASON_ABANDON`: the
  chain judged it, not a referee), `resume` with every seat's reopen approval
  or, in a timed game, the referee's alone (`resume_by_referee`), `void` for a
  roll that waited too long (`REASON_VOID`), and `resign` at any time.
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
fn open_dispute(ref self: ContractState, game_id: felt252, epoch: u32) {
    let mut world = self.world_default();
    binding::open_dispute(ref world, game_id, epoch);
}
```

- The game adds `referee_dojo::models::{m_ChannelTerms, m_ChannelState, m_ProverAllowed,
  e_ChannelUpdated}` to `build-external-contracts`, and `sozo` registers them
  in the game's namespace.
- A channel is stored in two models:
  - `ChannelTerms`, written at create and join only: 2 seats (wallet, session
    key, randomness tip), the prover, the time control, the serialized game
    `Config`, the context and the response window.
  - `ChannelState`, written on every transition: the anchor's hash, the
    candidate's (zero while it is the anchor), and two packed words for
    status, epoch, deadline, blocks, the acknowledgement, both references'
    small fields and the result.

  Transitions that need no terms beyond the seats or the referee key read
  only those members. `get_channel` returns both as one `ChannelGame`, and
  `ChannelUpdated` is the readable view for indexers. Compared with one
  41-field model, a 9×9 game's create, join, settlement, rating and kifu take
  about 18% less execution gas in tests (`scarb test -f gas_profile` in
  Surround), with fewer storage slots and event felts on top.
- `create` takes an `Option<TimeControl>`, checked by the game's time rules. A
  referee key must be a curve point and neither seat's session key.
  `ChannelTerms` keeps the referee key and the serialized settings, whatever
  the rules. A nonzero `clock.rng_tip` asks for the referee's randomness, and
  `join` then takes the referee's tip and its signature over it, which it
  checks (see Referee randomness).
- Callers are authenticated by wallet for create, join, cancel, dispute, forced
  play, timeout and resign. `submit_history`, `resolve`, `acknowledge`,
  `resume_by_referee`, `roll` and `void` are open to anyone, for example a
  keeper. `acknowledge` and `resume_by_referee` carry the referee's signature,
  `roll` the referee's next chain value, and `void` every seat's approval
  unless the pause has run out. `accept_verified` accepts only the game's
  prover.
- `allow_prover` lets namespace owners allowlist adapter classes.
- Rewards read `binding::result(world, game_id)` once a game is SETTLED.

## Proof adapter

`adapter/referee_adapter` holds the logic, and a game's adapter is an
immutable `#[starknet::contract(account)]` of about 40 lines
(`adapter/examples/counter/src/lib.cairo`) that pins the virtual OS program in
its constructor.

- **`__execute__` (virtual).** A zero-fee INVOKE_V3 that is never broadcast. It:
  - reads the channel's `snapshot`;
  - checks the start state against the anchor or the candidate;
  - replays the signed steps with the game's rules;
  - emits one L2→L1 message: adapter class, `TAG`, `'REFEREE_PROVED_V1'`,
    chain, adapter, channel, game, context, epoch, start hash, end hash.

  A prover proves this execution.
- **`settle` (real).** A transaction with the proof attached. `settle` checks the
  network-verified proof facts:
  - PROOF1 or PROOF2;
  - the virtual SNOS program pinned at deployment;
  - a base block at or after the block that set the start state, and at most
    4000 blocks old;
  - exactly one message equal to the expected transition.

  It then calls the channel's `accept_verified`.
- **No typed interface per game.** The adapter reaches the channel through
  raw syscalls (`snapshot`, `accept_verified`), so it works with any
  referee_dojo game system.
- **Calldata convention.** A game's adapter declares
  `__execute__(channel, game_id, epoch, start, witness, batch)`
  (no `witness` argument when the game's witness is `()`) and
  `settle(channel, game_id, epoch, start_hash, end, acks)`, which is what the JS
  proving client builds.

**JS proving client** (`@referee/sdk/proving`), for any game:
- `proveSession({ rpcUrl | provider, proverUrl, session, epoch, expectedClassHash })`
  waits until the state it starts from is 10 blocks deep, checks that the session
  starts at the anchor or the candidate under the current epoch and that the prover is the
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
- A transcript is stored in pieces: its start (terms, anchor envelope and
  witness) and each step, keyed by the `seq` and transcript they reach, and a
  pointer to the start and the end. The transcript commits to the whole history
  before it, so two branches never share a key and pieces are never rewritten;
  a save writes only its new steps, then the pointer, which is the only key it
  overwrites and the one it checks against another tab. `load` follows the
  steps back from the end. A transcript saved whole by an older SDK still
  loads, and is saved in pieces from then on.
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
  account sends only `submit_history`, `resolve`, the adapter's `settle`, and
  a referee's `acknowledge` and `resume_by_referee`, which anyone may send.
- **Admission.** Only open games count against `max_open_games`; settled and
  cancelled ones leave memory and stay on disk. Per-player limits
  (`max_open_per_player`) apply only to unanchored games, which need nothing
  but wallet signatures, and those close when finished or idle. An entry's
  `admit` hook ranks games for the `reserved_games` near capacity, so a game
  a matchmaker paired can't be crowded out. A game whose `maxSteps(config) +
  1` exceeds its entry's `max_steps` is refused up front.
- **Archive.** A game is admitted when its context matches the one the
  channel stores. Where two branches meet, the one that ranks higher as a
  dispute candidate is kept. Two different steps one seat signed at one seq
  are stored as equivocation evidence.
- **Transport.** Clients (`@referee/sdk/keeper`) register a session, send
  steps, and get the other seat's by long poll (`pull`) or a server-sent event
  stream (`follow`). The stream pushes each batch as the archive gets it, with
  no gap between polls, and serves spectators too. Clients verify every step
  they apply, and both refuse a branch that diverges from their own.
- **Watcher.**
  - For a timed game it referees, it `acknowledge`s a dispute at once, so the
    dispute returns to offchain play. If the acknowledgement isn't onchain by
    `deadline − answer_margin_seconds`, it submits the latest attested state
    instead, so forced play would start there.
  - It answers other disputes once, near the deadline, from the channel's
    candidate when its history holds it (`disputeAnswer`), and again only
    against a newer candidate someone else submitted.
  - It settles a finished game in segments of at most `proof_max_steps` (with
    a prover) or `replay_max_steps` steps, each extending the candidate within
    one dispute window, and resolves once the window passes. An entry's
    `afterSettle` hook adds calls to that `resolve` (Surround rates the game)
    when the bundle simulates, and sends them apart otherwise.
  - It returns a timed game it referees from forced play with
    `resume_by_referee` once its archive holds the anchor. Forced moves and
    timeout claims need a player's wallet, so it leaves them alone.
  - With an entry's `world` and `namespace`, it registers joined games that
    name its referee key from the channel's `ChannelUpdated` events, so every
    such game has a referee even if no seat registers it.
- **Channel reads.** A game system exposes `get_channel(game_id)`, which
  returns the `ChannelGame` view (`ChannelTerms` and `ChannelState`
  together), decoded by the SDK's `getChannel`.
- **Referee.** With a referee key, the keeper referees the timed games whose
  terms name that key. The relay is where steps first arrive, so it is where
  they are stamped.
  - Unstamped steps are stamped on arrival (`Archive.append`), and a timer
    flags the due seat at its `deadline()`. The watcher then settles the
    flagged game like any finished one.
  - A late step is refused (`'Flag fell'`) and the seat flagged.
  - It never stamps a second step at one seq, so it attests one branch.
  - On restart it resumes each clock at its last stamp.
  - A new game's clock starts with its first step, or with one `Start` after
    `start_grace_seconds`. After play resumes from forced play it stamps
    nothing and flags no one until it restarts the clock, once per epoch, so
    the forced period is charged to no one.
  - A keeper that is not the game's referee accepts only stamped steps.
  - With a randomness secret, it gives the games that ask their randomness:
    it signs each one's tip (`POST …/tip`), rolls as soon as it stamps a
    `PlayRandom`, and refuses a game whose tip is not its own (see Referee
    randomness).
  - This role is trusted, unlike the rest of the keeper: a delay costs the
    delayed seat clock time, and seats cannot route around it.
- **Tests.** `keeper/katana.sh` runs the keeper on a local Katana with the
  counter world. It answers a stale dispute and resolves it into forced play,
  settles a finished game through the dispute window to SETTLED, referees a
  timed game, flagging the stalling seat and settling the flag, and gives
  another its randomness: the join carries its signed tip, and the channel
  replays its roll.

## Proving strategy

- **Whole game in one proof when it fits.** Final-signature authentication and
  transcript binding keep traces small. Surround's 311-action v3 game is
  1.57M trace instructions.
- **Checkpoint proofs otherwise.** Each proves a segment from the committed
  anchor, or extends the candidate within a dispute, and commits it onchain. This works with PROOF1 today, and PROOF2 only
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

## Referee randomness

Built in protocol version 5. With player commit-reveal, the revealer must be
online for every roll: in Hashfront, every attack waits for the defender. A
timed game already has its referee on every step, so the referee can supply the
randomness instead. It helps 2-seat games, so it came before more than 2 seats
(next section).
- **Commitment.** The referee commits its own hash chain in the terms, like a
  seat: `TimeControl.rng_tip`, zero when the seats reveal.
- **The tip is the referee's.** A seat that made the tip up would know every
  roll, so the referee signs it for the one game (`tip_hash`:
  `'REFEREE_TIP_V1'`, chain id, channel, game id, tip) and the channel checks
  that signature. The game id exists only after `create`, so the creator asks
  for referee randomness there, with a nonzero `clock.rng_tip`, and `join`
  brings the signed tip. A game no channel anchors has the tip in the terms
  its wallets sign, and each seat checks the signature first.
- **One secret.** The keeper derives each game's chain from one randomness
  secret and the game's ids, so it stores nothing and a backup needs that
  secret, not the signing key. The chain has a value for every roll the game's
  `max_steps` allow (a roll takes two steps), so the referee never recommits.
  Building it costs one hash per value. The keeper keeps one value in 64
  (`RngChain`).
- **Rolls.** While the referee owes a roll, `pending.seat` is `REFEREE`, and
  its value is an ordinary `Reveal`: checked against its chain
  (`Envelope.rng_referee`), mixed with the requester's value into the seed, and
  charged to nobody's clock. No flag falls meanwhile, and a seat may still
  resign. The referee stamps a `PlayRandom` and reveals in one go, so a roll
  resolves as soon as it is stamped. No seat reveals.
- **Per game.** The terms opt in, not the rules: a game's `apply` still names
  a seat to reveal, and the protocol has the referee reveal instead. Player
  commit-reveal stays the default: it needs no trusted party, and games
  without a referee rely on it.
- **Ranking.** Referee steps no longer count as signer changes
  (`support_turn`): a roll would otherwise add two, and a `Start` between one
  seat's steps used to raise it.
- **Trust.** The referee can't bias a roll, since its values are fixed in
  advance, and it can't know a roll before the requester's step arrives. But
  a referee colluding with the requester could leak the roll before the action
  is signed. Randomness joins time in what the referee is trusted with.
- **More than 2 seats.** No coalition of players can predict a roll, and the
  revealer sets and the eliminated revealer's veto (next section) never arise.
- **A VRF** would need no chain for the referee to keep, but each roll would
  cost a proof check (elliptic-curve operations) instead of a hash.
  Cartridge's VRF resolves inside one transaction, so it doesn't fit offchain
  play.

**When the referee is down, the game pauses.**
- Offchain, it already does. Every step of a timed game needs the referee's
  stamp, and a restarted referee resumes from its last stamp, so it charges
  nobody for its downtime. A restarted keeper answers a roll it owed at once.
- In forced play, a roll played onchain waits for the referee's value.
  (Forced play happens when a seat opens a dispute while the referee is
  down.) No seat is due, so `claim_timeout` refuses, and the forced-play
  deadline becomes a 3-day pause (`PAUSE_SECONDS`).
- Anyone can post the referee's next value onchain (`roll`). The chain checks
  it against the referee's committed chain, so it needs no signature. A backup
  keeper that holds the randomness secret can unfreeze the game, which keeps
  real outages short. The next seat then gets a fresh window.
- The referee can also take the game back (`resume_by_referee`) and roll
  offchain. The keeper does that once its archive holds the channel's anchor,
  which a step played onchain never reaches by itself: a seat registers its
  session again from that anchor. Nothing does so automatically yet, and the
  keeper does not post `roll` itself.
- A pause has an end. The seats can all agree to void the game (they sign
  `void_hash`, `'REFEREE_VOID_V1'`), and after 3 days anyone can end it void.
  Falling back to a seat's reveal instead would let a colluding referee
  re-roll by going quiet. Void only lets it cancel a game, and only by
  stalling visibly for 3 days.
- Void is not a draw. It settles with `REASON_VOID = 131` and no winner, and
  reward code must check the reason.

**Tests.** The fixture game `rolled` replays in Cairo against the SDK
(`rolled_replay_matches_sdk`, `rolled_replay_splits_at_a_pending_roll`). The
clock, channel and Dojo suites pin the rest, for example
`a_roll_charges_nobody`, `nobody_times_out_while_the_referee_owes_a_roll`,
`a_tip_the_referee_did_not_sign_is_refused` and
`anyone_posts_the_referees_roll`. `keeper/katana.sh` plays such a game on a
local Katana.

## More than 2 seats (planned)

*Planned, not built; it would be protocol version 6.* Referee plays exactly 2 seats: `open` asserts `SEATS == 2` in
Cairo and the SDK. This section records what more seats need, found by a spike
that ran a 3-seat game through v4 on 2026-09-30, and proposes how to build it.
Hashfront launches with 2 seats, and is the first game planned for more. It
plays 2 to 4:
- a turn is any number of actions, ended by END_TURN;
- an attack's defender reveals the roll, and the attacker keeps its turn;
- a seat is out when it loses its HQ, or its units, factories and gold;
- the game ends when one seat is left, or after 100 rounds.

The spike's game, Trio, has the same shape: END passes the turn, and ATTACK
names a defender, who reveals.

**Surround.** Neither Surround nor referee is in production, so the protocol
may break its API. Surround, 2 seats only, is updated alongside each layer,
and must:
- pass its own suites, with the same results;
- stay at or below 72.8M gas for a 9×9 game.

With 2 seats, a resign, flag or timeout still ends the game with the other
seat winning. `alive`, `eliminate` and `placements` have defaults, so a 2-seat
game needn't write them. Cairo 2.13 allows defaults that use the trait's types
and constants (checked). The version bump changes every context hash, as v4's
did, and worlds are redeployed rather than migrated.

**What already works.**
- Encodings and hashes: `Terms` and `Envelope` carry per-seat spans, and the
  SDK and Cairo agree on a 3-seat game's context and state hashes.
- Replay verifies one final signature per seat, for any number of seats.
  Checkpoint approvals are N-of-N, eliminated seats included (see
  Eliminations).
- `StandardTime` keeps one bank per seat, and `ClockRules::open` takes the seat
  count.

**What breaks.**
- Seat 2 can't play in the SDK. Besides `open`, `applyStep`, replay,
  `Session.sign` and `SessionStore.move` refuse any seat but 0 and 1, and a
  reveal must come from one of them. `gameOutcome` refuses a winner above 2,
  where Cairo allows up to `SEATS`.
- Calls and signing state hold 2 seats. `finalSignatures`, `batchOf` and the
  proving client's `NO_ACKS` carry 2 signatures, so the keeper's submissions
  and settlements would fail onchain. The store reloads the marks of seats 0
  and 1 only, so after a restart a third seat would lose its signing guard.
- Endings pick the wrong winner. `forfeit` is "the other seat wins"
  (`2 - seat`): with 3 seats, seat 0 forfeiting crowns seat 1, seat 1 forfeiting
  crowns seat 0, and seat 2 forfeiting draws. One seat's resign ends the game
  for everyone, and a `claim_timeout` against seat 1 crowns seat 0, whoever
  claims it.
- The Dojo binding stores seats in pairs (`player_0`/`player_1`,
  `key_0`/`key_1`, `tip_0`/`tip_1`), which the SDK's `decodeChannelGame` reads.
  - `create` takes one invitee.
  - `join` fills seat 1 and opens the channel at once. It checks the joiner's
    wallet, key and tip against seat 0 only.
  - Looking up a caller refuses seats above 1. So seat 2 couldn't open a
    dispute, resign or claim a timeout. It couldn't play its forced turn either,
    and the timeout would then settle against it.
- Collusion. Two seats can outrank a branch the third signed, and a colluding
  pair knows its rolls in advance (below).

**Forks and collusion.** Candidates rank by signer changes (`support_turn`).
With 2 seats a signer change is the opponent acknowledging, so a fork that drops
the opponent's moves holds one seat's steps and loses. With more seats, a
coalition acknowledges its own steps:
- In the spike, after a round, A attacks B twice and B reveals each time. A
  never passes, so C is never due. Those four signer changes beat the honest
  round's three, and the channel replaces the candidate C signed with the
  fork. In Hashfront, a few attacks between two colluding seats do this.
- A fork needs no equivocation to start. A seat may sign a `Resign` at any
  position it never signed, however old, and replay takes it.
- A coalition at least as large as the honest seats can match any rank that
  counts signatures.

Decided: **a game with more than 2 seats has a referee**, and its attestation
decides between branches.
- Replay and proofs already require the referee's attestation of the state they
  end in. An honest referee stamps one branch, so every submission is a prefix
  of it, and a longer prefix always outranks a shorter one.
- The keeper's referee already keeps to one branch. It never stamps a seq it
  has stamped before. Its branch switch (`switched`) replays the other branch
  through `Session.receive`, which in a timed game needs the referee's own
  attestation on every step, so it can't adopt a fork the referee never
  stamped.
- A coalition can't fork without the referee. Two attestations at one seq with
  different transcripts prove that the referee equivocated, which the planned
  referee bond could slash (roadmap item 9). The referee's trust grows from
  time to order, and the trust model must say so.
- Games without a referee would need fork evidence onchain instead. If `Resign`
  were limited to the resigning seat's own turn, every fork would start with
  the due seat signing two steps at one position. But a proof hides a fork's
  steps, so the honest seat may never see the second signature. That is left
  for later.

Referee steps already stopped counting as signer changes in v5, for 2 seats
too: a `Start` between one seat's steps used to raise `support_turn`, which a
referee colluding with that seat could use.

**Eliminations.** One seat leaving must not end the game. Proposal:
- The game says who is still in: `GameRules::alive(state, seat)`. The
  protocol removes a seat with `eliminate(config, state, seat)`.
  - `Resign`, `Flag` and an onchain timeout eliminate a seat instead of
    calling `forfeit`.
  - The protocol checks the seat is out afterwards, and that `due` never names
    an eliminated seat.
- When one seat is left and `outcome` has not ended the game, the protocol ends
  it with `adjudicate`.
- With 2 seats, a `Resign`, `Flag` or timeout still ends the game with the
  other seat winning, as today. So `alive` and `eliminate` have defaults that
  only a 2-seat game may rely on. A game with more seats must implement them,
  and the protocol's checks catch one that doesn't.
- `StateRef` carries the eliminated seats as a bitmask, so zero means nobody
  is out: the safe default. A mask of live seats left at zero would read as
  nobody in: no approvals needed, and nobody able to claim a timeout. The
  channel asks only seats still in to approve checkpoints and `resume`, and
  lets any seat still in that isn't due claim a timeout.
- `claim_timeout` takes the anchor envelope as calldata, as `force` does,
  because with more than 2 seats a timeout changes the game state. Forced play
  then continues with the next due seat, on a fresh window.
- With more than 2 seats, a wallet resign is allowed only in forced play
  (decided). In offchain play a seat signs `Resign`, and the referee sequences
  it.

**Outcomes.** `Outcome { finished, winner, reason }` names one winner.
Hashfront rates games by finishing place (decided), so outcomes carry places.
Proposal:
- Add each seat's place: 1 for first, with a shared place for draws and
  teams.
- A new `GameRules::placements(config, state)` supplies the places. Its default
  derives them from `winner`, so a 2-seat game needn't write it.
- `winner` stays: the seat alone in first place, or `DRAW`.
- With more than 2 seats, the Dojo binding stores the places once, at
  settlement, beside the packed state. With 2 seats they follow from the
  winner.

**Randomness.** A seed mixes the requester's value and one revealer's. Their
hash chains fix both in advance, so a colluding pair knows a roll before it
signs the action. For Hashfront that is enough: the defender is the only other
party to its fight, and a colluding defender could throw the fight anyway. A
roll that affects everyone needs everyone's value. Decided: sets of
revealers.
- `apply` returns the set of seats that must reveal, as a bitmask, instead of
  one seat.
- The seats reveal in seat order, so `Reveal` stays seat-implicit, and the
  seed takes each value in turn.
- A game that names every other live seat gets a roll that only all the seats
  together could predict. It costs one step and one round trip per revealer.
- If a named revealer is eliminated before revealing, the roll resolves from
  the values revealed so far (decided). A colluding revealer can veto a roll
  that way, at the price of its seat.

A game that takes its randomness from the referee (previous section) needs
none of this: no seat reveals.

**Seats.** `SEATS` is a constant, so a game that plays 2 to 4 would need a
deployment per count. Proposal: `GameRules::seats(config)` replaces `SEATS`, so
Hashfront's map can set it; a 2-seat game returns 2. `open` and `create` check
it against `terms.players`, with at most 16 seats (decided). Everything else
uses the envelope's per-seat spans.

**Joining.** Proposal: one set of entrypoints for every seat count.
- `create` takes the config, and so the seat count, plus one optional invitee
  per seat. The creator takes seat 0.
- `join` names the seat it fills. It checks the joiner's wallet, key and tip
  against every seat: two seats sharing a key would let one signature approve
  for both.
- The channel opens when the last seat joins, and until then the creator may
  cancel.
  - The last join emits JOINED, as today, so the keeper's discovery keeps
    working.
  - Earlier joins emit a new kind.
- Every seat is stored the same way: a `ChannelSeat(id, seat)` row per seat,
  or lists in `ChannelTerms`, whichever measures cheaper. `get_channel` and the
  SDK's `decodeChannelGame` change shape.

**The rest of the stack.**
- The SDK mirrors all of the above and drops its 2-seat checks.
- `SessionStore` keeps a mark per seat.
- The keeper's referee flags a seat and keeps stamping for the others. It must
  keep to one branch, as it does today.
- The adapter only replays, so it changes with the core. Its proofs carry one
  more signature per seat.

**Build order.** One protocol version, built bottom-up, one layer per change:
1. The core and the SDK mirror together, driven by a new 3–4 seat example game
   with fixtures from the SDK. The counter keeps covering 2 seats.
2. The channel state machine.
3. The Dojo binding.
4. The adapter, the store, the keeper and the docs.

Surround is updated at each layer and keeps its results and gas (above). The
spike's collusion scenarios become tests that the new rules must reject.

**Decisions** (2026-09-30).
1. Games with more than 2 seats have a referee.
2. At most 16 seats.
3. Sets of revealers.
4. A revealer eliminated before revealing: the roll resolves from the values
   revealed so far.
5. With more than 2 seats, a wallet resign only in forced play.
6. Hashfront launches with 2 seats and is the first game planned for more.
   Surround stays at 2.
7. Breaking changes are fine. Neither Surround nor referee is in production,
   and Surround is updated alongside.
8. Hashfront rates games by finishing place, so outcomes carry places.

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
   The keeper also streams steps as server-sent events. Network delay is
   charged to the seat that has it, which is noise against clocks of seconds;
   `turn_ms` can serve as a grace if tighter clocks ever need one. Still to
   do: a referee bond that equivocation evidence can slash.
10. More than 2 seats: designed, not built. See
    [More than 2 seats](#more-than-2-seats-planned).
11. ~~Referee randomness.~~ Done, in protocol v5: a timed game can take its
    randomness from its referee, so no seat has to be online to reveal. See
    [Referee randomness](#referee-randomness).

## Development

```bash
scripts/check.sh    # regenerate fixtures, fmt check, test on Cairo 2.13.1 and 2.18.0
```

The counter fixtures are produced by the JS SDK (`sdk/scripts/gen-counter-fixtures.mjs`),
so the Cairo tests check the two implementations against each other.

The SDK's Poseidon is WebAssembly built from `sdk/poseidon` (Rust) into
`sdk/src/poseidon-wasm.mjs`, which is committed, so installing the SDK needs no
Rust. `npm run poseidon` rebuilds it (Rust with the `wasm32-unknown-unknown`
target); the build is reproducible, and the file records the module's sha256.
Where WebAssembly cannot run, the SDK falls back to starknet.js
(`POSEIDON_BACKEND` says which).
