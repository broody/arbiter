# arbiter keeper

One service that keeps arbiter games moving when players can't or won't:

| Part | What it does |
| --- | --- |
| archive | Keeps each game's signed transcript ([`archive.mjs`](archive.mjs)). Clients register a session and send steps. The keeper stores only steps that `Session.receive` verifies. |
| transport | Forwards steps between the seats. A client long-polls for the other seat's steps or follows a server-sent event stream. A player who refreshes, switches device or comes back online restores the game from here. |
| watcher | Reads every open game's channel ([`watch.mjs`](watch.mjs)). It answers disputes once, resolves expired ones and settles finished games, in segments when long, from the keeper's own account ([`chain.mjs`](chain.mjs)). A finished game nobody opened yet opens in the transaction that settles it. |
| referee | Optional. With a referee key, it registers the timed games that open onchain naming that key, stamps their steps, starts their clocks, flags a seat whose time runs out, acknowledges their disputes and returns them from forced play. With a randomness secret too, it gives the games that ask their rolls. |

```bash
KEEPER_PRIVATE_KEY=0x... node keeper/server.mjs keeper/config.local.json   # see config.example.json
```

Clients use `@arbiter/sdk/keeper`:

```js
const keeper = new KeeperClient('https://keeper.example');
await keeper.register(session, { authorizations });      // once: each wallet's signature over the terms
const record = await store.move(session, step, key);     // @arbiter/sdk/store
await keeper.send(session, record.seq);                  // our step
await keeper.pull(session, { wait: 30, store });         // the other seat's, verified
const restored = await keeper.load(game, terms);         // a new device

// Or keep one stream open instead of polling:
const stop = new AbortController();
keeper.follow(session, { store, signal: stop.signal, onSteps: records => render(session) });
```

In a timed game, `store.move` signs the step without applying it. The keeper
that referees the game stamps it, and the client applies it from there:

```js
const record = await store.move(session, step, key);     // signed, not yet applied
await keeper.submit(session, { store });                 // every pending step, stamped by the keeper
```

**Trust.** The keeper's trust model is the prover gateway's:
- It can't forge a step, because it keeps only steps whose signatures verify.
  Every client verifies again whatever it pulls.
- It can delay or withhold steps. Both players keep their own copies
  (`@arbiter/sdk/store`), so it's never the only copy.
- It holds no player keys. Its account pays only for `submit_history`,
  `resolve`, the adapter's `settle`, `open_game` on the seats' own wallet
  signatures, and the referee's `acknowledge` and `resume_by_referee`, which
  anyone may send, and the calls an entry's `afterSettle` hook returns.
- Anyone can run one.
- **Except as a referee.** Players trust the keeper named in a timed game's
  terms with time: a delayed step costs its seat clock time, and seats can't
  route around the referee. It still can't forge moves or results, so an
  honest player's worst case is losing on time. Players opt in per game by
  signing terms that name the referee's key. Use a key for refereeing that is
  kept apart from the keeper's account key.
- **And with the dice, when a game asks.** In a game that takes its randomness
  from the referee, the keeper can't bias a roll and can't know one before
  the step that asks for it arrives. It could tell the acting player its next
  value ahead of time, so players trust it not to. Keep the randomness secret
  as safe as the referee key.

## Archive

- **Admission.** A registered game must be on a configured channel and chain,
  and pass `Session.import`. A game a channel holds must match the context
  the channel stores onchain, which binds every term. A game no channel holds
  comes with each seat's wallet signature over its terms instead (see Signed
  terms). Squatting a game id with other terms therefore fails. Its codec's
  `maxSteps(config) + 1`, the longest transcript the protocol allows it, must
  fit the entry's `max_steps` (409 otherwise).
- **Capacity.** At most `max_open_games` games are open. A settled or evicted
  game leaves memory and the count, and stays on disk, readable. The
  last `reserved_games` slots go only to games the entry's `admit` hook ranks
  above 0 (see Config). `GET /info` reports the free capacity, so a matchmaker
  can check it before it pairs a game here.
- **Signed terms.** A game no channel holds is admitted on its seats' wallet
  signatures: each seat's wallet signs the terms (`termsTypedData(game,
  terms)` in `@arbiter/sdk`, SNIP-12), and `register` sends the signatures in
  seat order (`authorizations`). The keeper checks each against the seat's
  account contract (`is_valid_signature`, through `rpc_url`; without one it
  checks nothing) and keeps them with the game. The terms' context binds
  every term, session keys included, so the signatures bind each wallet to
  its key, as `open_game` checks onchain. A game's id must be its seats'
  (`gameIdOf(players, keys)`, as `open_game` requires; 403 otherwise). Such
  games cost their players nothing, so each wallet plays at most
  `max_open_per_player` of them here (429 beyond), and one closes after
  `unanchored_ttl_seconds` without a step. There are two kinds:
  - **Not opened yet.** A game on a real channel that nobody has opened: the
    usual case, since a game opens only when it first needs the chain. It
    must start at its opening. The watcher opens it with these signatures in
    the transaction that settles it (see Watcher), so a finished one is never
    closed: it waits to settle. Once a channel holds it, it stops counting
    against its wallets' caps, and the caps never apply to it again: a
    staller can't fill them to keep the referee off a game that is open.
  - **Unanchored.** A game entry with `anchored: false` keeps games that
    never touch the chain, such as free casual ones. The terms name the
    entry's channel value, which is no real channel, so their signatures can
    never settle anywhere, and the watcher leaves them alone. One closes once
    finished.
- **Branches.** Steps that overlap the archive are checked position by position.
  When a step differs from the stored one:
  - the other branch replaces the archive only if it ranks higher, as the
    channel ranks dispute candidates (`support_turn`, then `seq`);
  - otherwise the keeper answers 409 with the stored step.
  A client whose history has diverged is told so by `pull`. A client still on
  the shared prefix just follows the stored branch.
- **Equivocation.** Two different steps signed by one seat at the same seq are
  stored as evidence (`GET …/evidence`): both messages, both signatures and
  the position.
- **Re-anchoring.** A session that starts at a later anchor inside the stored
  history is merged. A session with a disjoint history, for example one
  resumed after forced play onchain, replaces the archive only if it starts at
  the channel's current anchor.

## Referee

A keeper started with a referee key referees every timed game whose terms name
that key (`clock.referee`):
- **Registration.** With `world` and `namespace` set on an anchored entry, the
  watcher reads the world's `ChannelUpdated` events of kind OPENED, reads each
  new game's terms (`terms(game_id)`), and registers the timed ones that name
  its key from their opening state. Such a game gets a referee even if neither
  seat registers it. A game usually opens only to settle or to be disputed,
  though, so a timed game has its referee while it is played only if a seat
  or a matchmaker registers it. Each opening costs one terms read. A
  registration that fails for a reason that may pass, such as an RPC error or
  a full keeper, is kept
  in the store and retried each round, one more terms read each time, until
  the game registers or the archive refuses it (e.g. closed here).
- **Stamps.** Each unstamped step is stamped when it arrives, before it is
  archived and forwarded. A step arriving after its seat's time ran out is
  refused (`Flag fell`) and the seat is flagged.
- **Starts.** A new game's clock waits for its first step. If none comes
  within the entry's `start_grace_seconds` of the keeper learning of the game,
  the referee stamps a `start`, and the due seat's clock runs from there. A
  clock already running is never restarted.
- **Flags.** A timer per game fires at the due seat's `deadline()` and appends
  the referee's `flag`. The watcher then settles the flagged game like any
  finished one.
- **Forced play.** While the channel is in forced play, the referee stamps
  nothing and flags no one. Once the channel resumes, its last stamp is stale,
  so flags wait until the clock restarts, once per resume: from the last stamp
  when the due seat's step comes first (a `start` would change the seq the
  step was signed at), or with a `start` after the start grace.
- **Step cap.** A game whose transcript reaches the entry's `max_steps` is no
  longer refereed: a seat whose step the cap refuses is never flagged.
- **One branch.** It never stamps a second step at one seq. A seat that signs
  another step there is recorded as equivocating, and nothing is stamped.
- **Restarts.** On start it loads every open game it referees and resumes each
  clock at its last stamp, so seats are not charged for the keeper's downtime.
- **Other keepers.** A keeper that is not a game's referee archives and
  forwards only stamped steps, and settles and answers disputes as usual.

### Randomness

A referee started with a randomness secret (`referee.rng_secret_env`) also
gives a timed game its rolls, when the game's terms carry the referee's
hash-chain tip (`clock.rng_tip`). No seat then has to be online to reveal.
- **Tips.** `POST /games/:channel/:game/tip` returns `{ rng_tip, signature }`:
  the tip of the keeper's chain for that game, and the referee's signature
  over it (`tipHash`). The terms carry the tip, every seat checks the
  signature before its wallet signs them, and `open_game` takes the signature
  and checks it again. The same game always gets the same tip.
  - A game no channel holds, the usual case since the tip comes before the
    terms are signed, sends its `config` with the request.
  - For a game a channel holds, the keeper reads its config from the channel,
    and answers only if its terms name this referee with a nonzero
    `clock.rng_tip`.
- **One secret.** Each chain comes from the secret and the game's ids, so the
  keeper stores nothing, and a backup with the secret can stand in. A chain
  has a value for every roll the game's `maxSteps(config)` allow. Building
  one costs a hash per value: about 0.1 ms each.
- **Rolls.** When it stamps a step that asks for randomness, the keeper reveals
  its next value as the next step, stamped at the same time. The roll charges
  nobody's clock, and nobody is flagged while one is pending.
- **Its own tips only.** It refuses to register a game that names it as
  referee with a randomness tip that isn't its own: it couldn't roll for it.
- **Restarts and forced play.** On start it answers a roll it owed when it
  stopped. A roll a seat asked for onchain, in forced play, is answered as
  soon as the channel resumes; the `start` still follows the start grace. The
  keeper resumes the channel once its archive holds the anchor, and reads
  forced play it did not see back from the chain (see Watcher). It doesn't
  post `roll` onchain itself.
  If the keeper stays down, anyone holding its next value may post it onchain
  (`roll`), and after 3 days the game can be ended void.

## Watcher

Each `poll_seconds`, for each open game:

| Channel | Keeper |
| --- | --- |
| Not opened yet, stored game finished | Opens it and submits it in one transaction: `open_game` on the seats' wallet signatures, with its own signature over the tip when it gives the game its randomness, then the first segment (see below). The game then runs as any other |
| Not opened yet, unfinished | Waits. A seat that needs the chain opens the game in its own transaction, with a dispute say |
| ACTIVE, stored game finished | Submits it (`settle`). Without approvals it becomes the candidate, and is resolved after the window |
| DISPUTE, stored game finished | Submits the next segment, if any (see below) |
| DISPUTE, a timed game it referees | Sends `acknowledge` at once while the candidate is unfinished, unless the channel holds it already, so `resolve` returns the game to play instead of forced play |
| DISPUTE, other games | Answers once, `answer_margin_seconds` before the deadline, with what outranks the candidate, extending it when it can (`disputeAnswer`). Again only against a newer candidate someone else submits |
| DISPUTE, window passed | `resolve`, with the game's `afterSettle` calls when it settles the game |
| FORCED, a timed game it referees | `resume_by_referee`, once per epoch, before the forced-play window closes and when the archive holds the anchor. If it doesn't, the keeper first follows the forced play from the chain (below) |
| FORCED, other games | Waits. Forced moves and timeouts need a player's wallet |
| SETTLED | Closes the game |

**Following forced play.** Steps played onchain never reach the archive by
themselves, and the keeper may have been down when they were played. For a
game it referees, it reads them back, once per anchor:
- It walks from the channel's anchor to a state the archive holds: the
  `ChannelUpdated` events in the anchor's block, each `force` or `roll` call
  in those transactions' traces, and the channel as it was one block earlier.
- It replays each call's steps from the state the call started at, and checks
  the result against the state the channel recorded. The transcript then
  starts at the anchor, and the keeper takes the game back as usual.
- It needs the entry's `world` and `namespace`, a node that serves traces and
  past state, and `decodeAction(reader)` in the game's codec. Without them a
  seat can still register its session again from the anchor.

A referee whose acknowledgement isn't onchain by `answer_margin_seconds`
before the deadline answers as for other games: forced play then starts from
the latest attested state, not a stale anchor. No submission is repeated each
round.

**Segments.** A submission holds at most `proof_max_steps` steps with a
`prover`, else `replay_max_steps`. A longer finished transcript settles as a
chain of segments within one dispute window: the first opens the dispute,
each next one extends the candidate, and the finished one lets `resolve`
settle the game. Each segment of up to `replay_max_steps` steps goes through
`submit_history`, an onchain replay; a longer one is proved through the game's
`prover` (see [`prover/`](../prover/README.md)) and settled with the adapter.
For a game nobody opened, the first segment starts at the opening, and goes
after `open_game` in the same transaction; a proof of it is proved from the
game's terms (`proveSession` reports `opening: true`).

**After settling.** When the keeper's `resolve` settles a game, it appends the
calls the entry's `afterSettle` hook returns, if simulating the bundle
succeeds, and otherwise sends them in a second transaction.

Transactions are sent one at a time, and each fee bound is checked against
`max_fee_fri`. Without an `account`, the keeper only watches and logs what it
would send.

## HTTP API

The API speaks JSON, with BigInts encoded as `{ "$n": "<decimal>" }`
(`stringify`/`parse` in `@arbiter/sdk/store`). Errors look like
`{ error: { message, data } }` and carry status 400, 403, 404, 409, 413, 429, 502 or 503.

| Request | Body / query | Answer |
| --- | --- | --- |
| `POST /games` | `{ record: session.export(), authorizations? }` | `{ start, seq, transcript, created \| accepted \| reanchored }` |
| `GET /games` | | open games |
| `GET /games/:channel/:game` | | `{ record, start, seq, transcript, authorizations? }` |
| `GET /games/:channel/:game/steps` | `?from=SEQ&wait=SECONDS` | `{ start, seq, transcript, steps }`: step records from `from`, long-polling up to `max_wait_seconds` |
| `POST /games/:channel/:game/steps` | `{ from, steps: [{ step, signature, stamp?, attestation? }] }` | `{ start, seq, transcript, accepted, switched? }` |
| `GET /games/:channel/:game/evidence` | | `{ evidence }` |
| `POST /games/:channel/:game/tip` | `{ config? }` | `{ rng_tip, signature }`: the referee's randomness tip for the game and its signature over it. `config` is for a game no channel holds: one not opened yet, or unanchored |
| `GET /games/:channel/:game/events` | `?from=SEQ` | A `text/event-stream`: an event `steps` whose data is `{ start, seq, transcript, steps }` each time the archive gets steps, and a comment line every `heartbeat_seconds` |
| `GET /info`, `GET /health` | | `/info` includes the `referee` public key, or null, whether it gives `randomness`, the `limits`, and the `capacity`: `{ open, max_open_games, reserved_games, free, free_unreserved }` |

POSTs are rate-limited per client (`rate_per_minute`) and capped at
`max_body_bytes`. Waiting clients, long polls and streams together, are
capped at `max_waiters`. Open games are capped at `max_open_games` (503),
games no channel holds per wallet at `max_open_per_player` (429: `Wallet 0x…
already plays N open games here that no channel holds`), and transcripts at
each entry's `max_steps`. Steps to a closed game get 409.

## Config

- `games`: one entry per game channel.
  - `module` and `export` locate its JS codec. A relative path resolves from
    the config file.
  - `entrypoints` renames the system's calls. Surround's are
    `resolve_dispute` and `get_channel`.
  - The game system must expose `get_channel(game_id) -> ChannelGame`. The
    counter's does.
  - `anchored: false` makes it an unanchored entry (see Archive): `channel`
    is then any value the entry's terms name, `0x0` for instance, and it takes
    no `prover`.
  - `max_steps` (default: the top-level `max_steps`, 4096) caps its
    transcripts. Set it from the codec's `maxSteps`: Go's bound is far below
    Hashfront's.
  - `replay_max_steps` (default 64; formerly `max_history_steps`) and
    `proof_max_steps` (default unlimited) size each submission (see Watcher).
    Both may also be set at the top level.
  - `start_grace_seconds` (default 120) and `answer_margin_seconds` (default
    600), per entry or at the top level.
  - `world` and `namespace`: the Dojo world and namespace of an anchored
    entry, for registering opened games (see Referee) and following forced
    play (see Watcher). Scanning starts at
    `from_block`, or at the chain's head the first time, and resumes where it
    stopped.
  - The game's system exposes `open_game`, `acknowledge`,
    `resume_by_referee` and `terms`, as arbiter_dojo's helpers name them.
  - Hooks: the module may export, next to the codec, `admit(ids, terms, {
    provider })`, the priority of a new game for the reserved slots (Surround
    ranks rated games first), `afterSettle(ids, channel, { provider })`, the
    calls to send with the resolve that settles a game (Surround's `rate`), and
    `openCall(ids, terms, { signatures, approvals, refereeSignature, extras,
    provider })`, the call that opens a game no channel holds yet when the
    channel's own `open_game` won't do, from the `extras` the game registered
    with (Surround opens a rated game with its ticket). `approvals` are the
    seats' as registered; `signatures` holds them as arrays when every one is
    a wallet's.
  - `delegation_seconds` (default 0: none): the longest delegation the
    entry's channel takes (`open_game_delegable`). A game no channel holds
    then registers on a seat's delegated approval (`delegatedApproval`) too,
    checked at the chain's time, and opens through `open_game_delegable`.
- `store`: the file store directory (`@arbiter/sdk/store/file`, one process
  per directory).
- `settle: false` stops the keeper from submitting finished games itself.
- `max_open_games` (default 10000; formerly `max_games`), `reserved_games`
  (default 0), `max_open_per_player` (default 4) and `unanchored_ttl_seconds`
  (default 86400): capacity (see Archive).
- `heartbeat_seconds` (default 15) spaces the comment lines that keep proxies
  from closing an idle stream.
- `referee.private_key_env` (default `KEEPER_REFEREE_KEY`) names the
  environment variable holding the referee's private key. Without `referee`,
  the keeper referees nothing.
- `referee.rng_secret_env` names the environment variable holding the
  referee's randomness secret, a felt. Without it, the keeper gives no
  randomness and refuses the games that would need it.

## Tests

- `node --test keeper/test/*.test.mjs`: the archive, the watcher, the referee,
  the step stream and the HTTP API against a fake chain, and the event and
  terms reads against a fake RPC provider. They include the admission attack
  (unanchored games filling a wallet's cap), games nobody opened yet (held on
  their wallets' signatures, left alone until finished, then opened in the
  transaction that settles them), self-registration from OPENED events and
  its retries, answering a dispute once, the fallback when an acknowledgement
  doesn't land, starts after the start grace and after forced play, chained
  segments, no flag after a step the cap refused, and the referee's tips and
  rolls.
- `node keeper/bench.mjs [STEPS]`: the latency a referee adds, from the SDK
  work per step to a step's trip through a refereeing keeper to the other
  seat's stream, with the memory and the file store.
- `keeper/katana.sh`: starts a Katana, deploys the counter Dojo world and runs
  [`katana.mjs`](katana.mjs) with real transactions. Every game opens on the
  Katana accounts' real SNIP-12 signatures. Alice opens a game and disputes
  it in one transaction, and the keeper answers the stale dispute and
  resolves it into forced play. The keeper opens and settles three games
  nobody opened, each in the transaction that submits it: a finished game,
  which it resolves to SETTLED; a timed game it referees, where it flags the
  stalling seat and settles the flag with reason TIMEOUT; and a game it gives
  its randomness: the terms carry its signed tip, it rolls for a gamble, and
  the channel replays the roll. Last, the keeper is stopped while a seat
  gambles onchain in forced play, and once restarted it follows the forced
  call, takes the game back and rolls. It passed with katana 1.7.1 and sozo 1.8.0 in
  about a minute and a half. sozo 1.8.5 fails to deploy the world on katana
  1.7.1.
