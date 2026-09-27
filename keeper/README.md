# referee keeper

One service that keeps referee games moving when players can't or won't:

| Part | What it does |
| --- | --- |
| archive | Keeps each game's signed transcript ([`archive.mjs`](archive.mjs)). Clients register a session and send steps. The keeper stores only steps that `Session.receive` verifies. |
| transport | Forwards steps between the seats. A client long-polls for the other seat's steps. A player who refreshes, switches device or comes back online restores the game from here. |
| watcher | Reads every open game's channel ([`watch.mjs`](watch.mjs)). It answers stale disputes, resolves expired ones and settles finished games, from the keeper's own account ([`chain.mjs`](chain.mjs)). |

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
```

**Trust.** The keeper's trust model is the prover gateway's:
- It can't forge a step, because it keeps only steps whose signatures verify.
  Every client verifies again whatever it pulls.
- It can delay or withhold steps. Both players keep their own copies
  (`@referee/sdk/store`), so it's never the only copy.
- It holds no player keys. Its account pays only for `submit_history`,
  `resolve` and the adapter's `settle`, which anyone may send.
- Anyone can run one.

## Archive

- **Admission.** A registered game must be on a configured channel and chain,
  pass `Session.import`, and match the context the channel stores onchain,
  which binds every term. Squatting a game id with other terms therefore
  fails.
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

## Watcher

Each `poll_seconds`, for each open game:

| Channel | Keeper |
| --- | --- |
| DISPUTE, window open | If the stored transcript from the anchor outranks the candidate, submits it |
| DISPUTE, window passed | `resolve` |
| ACTIVE, stored game finished | Submits it (`settle`). Without approvals it becomes the candidate, and is resolved after the window |
| FORCED | Waits. Forced moves and timeouts need a player's wallet |
| SETTLED, CANCELLED | Stops watching |

Transcripts of up to `max_history_steps` steps go through `submit_history`,
an onchain replay. Longer ones are proved through the game's `prover` (see
[`prover/`](../prover/README.md)) and settled with the adapter. Transactions
are sent one at a time, and each fee bound is checked against `max_fee_fri`.
Without an `account`, the keeper only watches and logs what it would send.

## HTTP API

The API speaks JSON, with BigInts encoded as `{ "$n": "<decimal>" }`
(`stringify`/`parse` in `@referee/sdk/store`). Errors look like
`{ error: { message, data } }` and carry status 400, 404, 409, 413, 429 or 503.

| Request | Body / query | Answer |
| --- | --- | --- |
| `POST /games` | `{ record: session.export() }` | `{ start, seq, transcript, created \| accepted \| reanchored }` |
| `GET /games` | | open games |
| `GET /games/:channel/:game` | | `{ record, start, seq, transcript }` |
| `GET /games/:channel/:game/steps` | `?from=SEQ&wait=SECONDS` | `{ start, seq, transcript, steps }`: step records from `from`, long-polling up to `max_wait_seconds` |
| `POST /games/:channel/:game/steps` | `{ from, steps: [{ step, signature }] }` | `{ seq, accepted, switched? }` |
| `GET /games/:channel/:game/evidence` | | `{ evidence }` |
| `GET /info`, `GET /health` | | |

POSTs are rate-limited per client (`rate_per_minute`) and capped at
`max_body_bytes`. Waiting clients are capped at `max_waiters`. Games and
transcripts are capped at `max_games` and `max_steps`.

## Config

- `games`: one entry per game channel.
  - `module` and `export` locate its JS codec. A relative path resolves from
    the config file.
  - `entrypoints` renames the system's calls. Surround's are
    `resolve_dispute` and `get_channel`.
  - The game system must expose `get_channel(game_id) -> ChannelGame`. The
    counter's does.
- `store`: the file store directory (`@referee/sdk/store/file`, one process
  per directory).
- `settle: false` stops the keeper from submitting finished games itself.

## Tests

- `node --test keeper/test/*.test.mjs`: the archive, the watcher and the HTTP
  API against a fake chain.
- `keeper/katana.sh`: starts a Katana, deploys the counter Dojo world and runs
  [`katana.mjs`](katana.mjs) with real transactions. The keeper answers a stale
  dispute and resolves it into forced play, then settles a finished game and
  resolves it to SETTLED. It passed with katana 1.7.1 and sozo 1.8.0 in about a
  minute. sozo 1.8.5 fails to deploy the world on katana 1.7.1.
