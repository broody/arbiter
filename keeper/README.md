# referee keeper

One service that keeps referee games moving when players can't or won't:

| Part | What it does |
| --- | --- |
| archive | Keeps each game's signed transcript ([`archive.mjs`](archive.mjs)). Clients register a session and send steps. The keeper stores only steps that `Session.receive` verifies. |
| transport | Forwards steps between the seats. A client long-polls for the other seat's steps or follows a server-sent event stream. A player who refreshes, switches device or comes back online restores the game from here. |
| watcher | Reads every open game's channel ([`watch.mjs`](watch.mjs)). It answers disputes once, resolves expired ones and settles finished games, in segments when long, from the keeper's own account ([`chain.mjs`](chain.mjs)). |
| referee | Optional. With a referee key, it registers the timed games that join naming that key, stamps their steps, starts their clocks, flags a seat whose time runs out, acknowledges their disputes and returns them from forced play. |

```bash
KEEPER_PRIVATE_KEY=0x... node keeper/server.mjs keeper/config.local.json   # see config.example.json
```

Clients use `@referee/sdk/keeper`:

```js
const keeper = new KeeperClient('https://keeper.example');
await keeper.register(session);                          // once, after joining
const record = await store.move(session, step, key);     // @referee/sdk/store
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
  (`@referee/sdk/store`), so it's never the only copy.
- It holds no player keys. Its account pays only for `submit_history`,
  `resolve`, the adapter's `settle`, and the referee's `acknowledge` and
  `resume_by_referee`, which anyone may send, and the calls an entry's
  `afterSettle` hook returns.
- Anyone can run one.
- **Except as a referee.** Players trust the keeper named in a timed game's
  terms with time: a delayed step costs its seat clock time, and seats can't
  route around the referee. It still can't forge moves or results, so an
  honest player's worst case is losing on time. Players opt in per game by
  accepting the referee's key in the terms. Use a key for refereeing that is
  kept apart from the keeper's account key.

## Archive

- **Admission.** A registered game must be on a configured channel and chain,
  pass `Session.import`, and match the context the channel stores onchain,
  which binds every term. Squatting a game id with other terms therefore
  fails. Its codec's `maxSteps(config) + 1`, the longest transcript the
  protocol allows it, must fit the entry's `max_steps` (409 otherwise).
- **Capacity.** At most `max_open_games` games are open. A settled, cancelled
  or evicted game leaves memory and the count, and stays on disk, readable. The
  last `reserved_games` slots go only to games the entry's `admit` hook ranks
  above 0 (see Config). `GET /info` reports the free capacity, so a matchmaker
  can check it before it pairs a game here.
- **Unanchored games.** A game entry with `anchored: false` keeps games that
  never touch the chain, such as free casual ones: no channel holds their
  terms, and the watcher leaves them alone. Instead, each seat's wallet signs
  the terms (`termsTypedData(game, terms)` in `@referee/sdk`, SNIP-12), and
  `register` sends the signatures in seat order. The keeper checks each
  against the seat's account contract (`is_valid_signature`, through
  `rpc_url`; without one it checks nothing) and keeps them
  with the game. The terms' context binds every term, session keys included,
  so the signatures bind each wallet to its key, as creating and joining a
  channel do onchain. The terms name the entry's channel value, which is no
  real channel, so their signatures can never settle anywhere. Clients pick
  random game ids. They cost their players nothing, so each wallet plays at
  most `max_open_per_player` open ones here (429 beyond). An unanchored game
  closes once finished, or after `unanchored_ttl_seconds` without a step. The
  caps never apply to anchored games: a staller can't fill them to keep the
  referee off a rated game.
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
  watcher reads the world's `ChannelUpdated` events of kind JOINED, reads each
  new game's terms (`terms(game_id)`), and registers the timed ones that name
  its key from their opening state. Such a game gets a referee even if neither
  seat registers it. Each join costs one terms read.
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

## Watcher

Each `poll_seconds`, for each open game:

| Channel | Keeper |
| --- | --- |
| ACTIVE, stored game finished | Submits it (`settle`). Without approvals it becomes the candidate, and is resolved after the window |
| DISPUTE, stored game finished | Submits the next segment, if any (see below) |
| DISPUTE, a timed game it referees | Sends `acknowledge` at once while the candidate is unfinished, unless the channel holds it already, so `resolve` returns the game to play instead of forced play |
| DISPUTE, other games | Answers once, `answer_margin_seconds` before the deadline, with what outranks the candidate, extending it when it can (`disputeAnswer`). Again only against a newer candidate someone else submits |
| DISPUTE, window passed | `resolve`, with the game's `afterSettle` calls when it settles the game |
| FORCED, a timed game it referees | `resume_by_referee`, once per epoch, before the forced-play window closes and when the archive holds the anchor |
| FORCED, other games | Waits. Forced moves and timeouts need a player's wallet |
| SETTLED, CANCELLED | Closes the game |

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

**After settling.** When the keeper's `resolve` settles a game, it appends the
calls the entry's `afterSettle` hook returns, if simulating the bundle
succeeds, and otherwise sends them in a second transaction.

Transactions are sent one at a time, and each fee bound is checked against
`max_fee_fri`. Without an `account`, the keeper only watches and logs what it
would send.

## HTTP API

The API speaks JSON, with BigInts encoded as `{ "$n": "<decimal>" }`
(`stringify`/`parse` in `@referee/sdk/store`). Errors look like
`{ error: { message, data } }` and carry status 400, 403, 404, 409, 413, 429 or 503.

| Request | Body / query | Answer |
| --- | --- | --- |
| `POST /games` | `{ record: session.export(), authorizations? }` | `{ start, seq, transcript, created \| accepted \| reanchored }` |
| `GET /games` | | open games |
| `GET /games/:channel/:game` | | `{ record, start, seq, transcript, authorizations? }` |
| `GET /games/:channel/:game/steps` | `?from=SEQ&wait=SECONDS` | `{ start, seq, transcript, steps }`: step records from `from`, long-polling up to `max_wait_seconds` |
| `POST /games/:channel/:game/steps` | `{ from, steps: [{ step, signature, stamp?, attestation? }] }` | `{ start, seq, transcript, accepted, switched? }` |
| `GET /games/:channel/:game/evidence` | | `{ evidence }` |
| `GET /games/:channel/:game/events` | `?from=SEQ` | A `text/event-stream`: an event `steps` whose data is `{ start, seq, transcript, steps }` each time the archive gets steps, and a comment line every `heartbeat_seconds` |
| `GET /info`, `GET /health` | | `/info` includes the `referee` public key, or null, the `limits`, and the `capacity`: `{ open, max_open_games, reserved_games, free, free_unreserved }` |

POSTs are rate-limited per client (`rate_per_minute`) and capped at
`max_body_bytes`. Waiting clients, long polls and streams together, are
capped at `max_waiters`. Open games are capped at `max_open_games` (503),
unanchored ones per wallet at `max_open_per_player` (429), and transcripts at
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
    entry, for registering joined games (see Referee). Scanning starts at
    `from_block`, or at the chain's head the first time, and resumes where it
    stopped.
  - The game's system exposes `acknowledge`, `resume_by_referee` and
    `terms`, as referee_dojo's helpers name them.
  - Hooks: the module may export, next to the codec, `admit(ids, terms, {
    provider })`, the priority of a new game for the reserved slots (Surround
    ranks rated games first), and `afterSettle(ids, channel, { provider })`,
    the calls to send with the resolve that settles a game (Surround's `rate`).
- `store`: the file store directory (`@referee/sdk/store/file`, one process
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

## Tests

- `node --test keeper/test/*.test.mjs`: the archive, the watcher, the referee,
  the step stream and the HTTP API against a fake chain, and the event and
  terms reads against a fake RPC provider. They include the admission attack
  (unanchored games filling a wallet's cap), self-registration from events,
  answering a dispute once, the fallback when an acknowledgement doesn't land,
  starts after a join and after forced play, chained segments and no flag
  after a step the cap refused.
- `node keeper/bench.mjs [STEPS]`: the latency a referee adds, from the SDK
  work per step to a step's trip through a refereeing keeper to the other
  seat's stream, with the memory and the file store.
- `keeper/katana.sh`: starts a Katana, deploys the counter Dojo world and runs
  [`katana.mjs`](katana.mjs) with real transactions. The keeper answers a stale
  dispute and resolves it into forced play, settles a finished game and
  resolves it to SETTLED, and referees a timed game: it flags the stalling seat
  and settles the flag with reason TIMEOUT. It passed with katana 1.7.1 and
  sozo 1.8.0 in about a minute. sozo 1.8.5 fails to deploy the world on katana 1.7.1.
