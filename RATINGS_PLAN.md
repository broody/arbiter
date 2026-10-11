# Ratings plan: ranked play for arbiter games

Created 2026-10-11. Status: steps 1–6 and 8 built on branches `feat/ratings`
(arbiter) and `feat/arbiter-ratings` (Surround), not yet merged or deployed;
step 7's Sepolia redeploy and step 9's review of the code are open. Reviewed by
Fable on 2026-10-11 before implementation: sound, no blockers; its fixes are
folded in below, and a spike compiled the component and trait on Cairo 2.13.1.
The source is Surround's ratings (`surround/ratings`, design and evidence in
Surround's `RANKING_PLAN.md`).

## Implementation status

| Step | State | Where the code departs from the plan |
| --- | --- | --- |
| 1 License | Done: `LICENSE` (MIT), the prover README's note on `prover/patches` (Apache-2.0), `"license"` in `package.json`, a License section in the README | — |
| 2 Engine | Done: `ratings/` (`arbiter_ratings`), in the root workspace and `scripts/check.sh` | `drift_of(half_life)` and `C_HALF_LIFE` are exported, so a game writes KGS-style aging in one line; `elo` is the default `shown` |
| 3 Component | Done: 127 tests (a chess-shaped `TestRules` with two pools, a test contract, a bad-pool contract, an upgrade contract); `ratings/fuzz/` (4 snforge properties, 11,000 runs) | `rate_game` also voids (`VOID_INVALID`) when an upgrade made the pool fail `valid_pool` or dropped a new player's band since the ticket, so no ticket stays accepted (from the SDK agent's review). Views of an unknown pool: `player` and `ranks` panic `'Unknown pool'`; the other per-pool views return defaults |
| 4 SDK | Done: `@arbiter/sdk/ratings`, 31 tests; `sdk/scripts/gen-rating-vectors.mjs` writes `ratings/src/tests/vectors.cairo` and `test_vectors.cairo` (8 Cairo tests, bit for bit) | Replay takes rules keyed by `params`, so events written under an older version still replay |
| 5 `arbiter_dojo` | Done: `RatedConfig` in `core` (not `arbiter_ratings`: it is a fact about the signed config), the guard in `open_game`, `Settlement`/`RatedGame`, `rated::{open_rated_game, open_rated_game_delegable, rated_result, rate}`; `dojo/examples/rated` (21 Dojo tests); settlement routes tested on the counter (69) | The config hash is Poseidon over `[GameRules::TAG, 'ARBITER_CONFIG_V1', …]`, the game's own tag first like `context_hash`; a config without a ticket is hashed as it is (an `Unrated` config can't run `with_ticket`). `is_rated_config` is generic over the config, not the rules. `rate` returns `(GameResult, Player, Player)`, so a game can date its own mirror events |
| 6 Surround | Done: `GoRatingRules`, `SurroundRatings` from the component, the channel on `arbiter_dojo::rated`; 24 ratings and 94 world tests, `vectors.cairo` and `audit_vectors.cairo` regenerate byte-identically; offchain SDK (52), matchmaker (58), anchors (11), web (172, `tsc` clean); a local Devnet game (`smoke.mjs`: 24 transactions, 32 checks) and the event replay (`replay-check.mjs`) pass | Surround keeps `ratings/src/math.cairo` as a thin Go wrapper over the engine, so its vectors and tests run unchanged. Rules version stays 2: the update didn't change. The matchmaker sends `{ ratings, size, komi_half, settings }` beside each ticket, and every party that builds terms checks them against the ticket's hashes (`ratedTerms`). Its HTTP API renamed `rank_tenths` to `shown`, `ratings` is a required config key, and its snapshot version went to 3, so stored state resets |
| 7 Measure, deploy | Measured; the Sepolia redeploy waits for the push | `rate_game` on Go's rules: 2.40M (first game) and 2.66M (second), +3.9% and +3.5% (pool keys, the longer digest). A rated 9×9 game (open, settle, rate): 48.24M gas in tests against 48.40M on `main` (−0.3%): `submit_history` −0.6% (the binding writes `Settlement` once), `rate` +1.4% |
| 8 Docs | Done: DESIGN.md (layers, a Ratings section, decision 4 amended, roadmap 13), README, and the docs site: concept, guide ("Add rated play") and two reference pages, with the binding, glossary and overview pages updated (`npm run build` passes) | The design text above was corrected to the code after the docs pass (config hash tag order, `rated_result`'s `Option`, no `sync` helper, event keys, two test pools) |
| 9 Review | Open | — |

Goal: any 2-seat arbiter game gets onchain ratings by implementing one trait,
the way it gets a channel by implementing `GameRules`. Surround moves onto the
shared code **before its mainnet launch**, so it never has to migrate a rating.
A chess game is the planned second user, and Hashfront's ranked play comes
after Surround's launch.

## Decisions already made (2026-10-11)

1. **Ratings live in arbiter**, as a new workspace member `arbiter_ratings`,
   with the JS side in the SDK. Today they are entirely in Surround; arbiter
   has nothing rating-specific beyond `Clock.started`, `TimeControl` and
   `signing_hash`.
2. **One deployment per game**, owned by that game. No shared instance: a shared
   one would make one owner the policy and key holder for every game's ranked
   play, and ratings from different games mean nothing side by side.
3. **Before Surround's mainnet** (weeks away): only what is hard to change
   after launch. See [Before and after launch](#before-and-after-surrounds-launch).
4. **One matchmaker per game.** The matchmaker stays in Surround until a second
   game needs one.
5. **arbiter is MIT.** Add `LICENSE`. The ratings code moves from Surround
   (AGPL-3.0-or-later) under MIT; its only author is the copyright holder.
   `prover/patches` modify StarkWare's repositories and keep their upstream
   license, stated in the prover README.
6. **Surround pins arbiter by git rev**, as today. No registry publishing yet.
7. **Review:** Fable reviews this plan and the implementation before mainnet,
   in place of an external audit.
8. **Sepolia testers' ratings reset** when Surround redeploys on the new code.
9. **Out of scope:** more than 2 seats, team ratings, ratings across games, a
   first-move advantage term (white's in chess).

## Design

### Layers

A new row for DESIGN.md's layer table, and `arbiter_dojo`'s row gains a
dependency:

| Layer | Depends on | Purpose |
|---|---|---|
| `arbiter_ratings` (Cairo 2.13) | `core` | `RatingRules`, the Q32.32 update, `Ticket`, `RatingsComponent` (players, tickets, policy, anchors, admin, events) |
| `arbiter_dojo` | `core`, Dojo, `arbiter_ratings` | adds `open_rated_game`, `rated_result`, `rate`, and the `Settlement` and `RatedGame` models; `RatedConfig` and `config_hash` live in `core` (`arbiter::rated`) |

The JS side goes into the SDK as `@arbiter/sdk/ratings`, a new `exports`
entry in `package.json`.

### Settings in code: `RatingRules`

Each game implements one trait, as it implements `GameRules`, and compiles its
own ratings contract from a shared component. OpenZeppelin uses the same
pattern for constants a component needs from its contract
(`ERC20Component::ImmutableConfig` in `openzeppelin_token` 3.0.0, the version
Surround pins).

```cairo
pub trait RatingRules {
    /// Domain tag in every ticket digest and admin op, e.g. 'SURROUND'.
    const TAG: felt252;
    /// Bumped when the update changes; stored per player (`params`).
    const VERSION: u8;
    /// Rated games take their randomness from the referee (Hashfront), or
    /// never take any (Surround).
    const REFEREE_RNG: bool;
    /// A pool's constants, or None for a pool the game doesn't have.
    fn pool(pool: felt252) -> Option<Pool>;
    /// The starting μ for a band (1..=7), or None.
    fn start(pool: felt252, band: u8) -> Option<i128>;
    /// c, the per-√day growth of φ at μ (Q). Surround: from its half-life by rank.
    fn drift(pool: felt252, mu: i128) -> i128;
    /// The rank shown for μ with the owner's offset, e.g. `elo(mu, offset)`.
    fn shown(pool: felt252, mu: i128, offset: i32) -> u16;
}

pub struct Pool {
    pub phi0: i128,
    pub min_phi: i128,
    pub mu_min: i128,
    pub mu_max: i128,
    pub provisional_phi: i128,
    pub settled_games: u32,
    pub min_steps: u32,
    pub anchor_phi: i128,
    pub anchor_mu_min: i128,
    pub anchor_mu_max: i128,
    /// The largest rank offset the owner may set, in `shown`'s units
    /// (Surround: 390 tenths).
    pub max_offset: i32,
}
```

- **Gas.** No setting is read from storage. `rate_game` calls `Rules::pool`
  once and passes `@Pool` through the engine. A rated game costs what it does
  today, apart from the pool in each storage key.
- **Bit for bit.** Surround's impl is today's constants, `half_life`,
  `rank_of`, `MU_T` and bands from `math.cairo`. `variance` computes c once,
  then `div(c * c * dt, DAY)`, capped at φ0² and `MAX_IDLE`. `drift` returns
  c, so the engine keeps that arithmetic exactly (checked in review).
- **The packing bounds every pool.** One felt per player holds:
  - every μ, peak (`μ − 2φ`) and anchor μ within ±2^39 in Q32.32, about ±128
    logits;
  - φ, and so φ0, below 2^34, that is below 4;
  - the band below 8, and the last-played time below 2^40.

  The engine's tests check these for every pool of a test impl, so a game
  can't ship a pool that panics while packing.
- **Changing a setting is an upgrade**, which waits 48 hours after `seal()`,
  as loosening policy does. Settings are part of the rating model, so they
  should be at least as hard to change as policy.
- **The engine keeps** the exp, sigmoid, sqrt and division code, `MAX_IDLE`,
  `DAY`, `g_of`, the update, aging, the clamp, peak, "settled", "established"
  and "provisional".

### Pools

- Ratings are keyed by `(pool, player)`. A pool is a `felt252` short string.
  Surround has one (`'go'`), covering 9×9, 13×13 and 19×19 as today. Chess
  would have `'bullet'`, `'blitz'`, `'rapid'` and `'classical'` in one
  deployment, so a player's records share one owner and timelock.
- Pools are independent: each has its own starting bands, record, peak,
  anchors and rank offset. Every policy map and the anchors are keyed by
  `(pool, …)`.
- `pool` is a **key** on `RatingUpdated` (after `player` and `digest`) and on
  `TicketUsed` (after `digest` and `channel`), so indexers can filter by pool.
- Packed player state is unchanged: one felt, with the band as an index into
  the pool's starting list.

### Ticket

Seats, not colors, and the game's terms as hashes:

```cairo
pub struct Ticket {
    pub chain_id: felt252,
    pub channel: ContractAddress,
    pub player_0: ContractAddress,
    pub player_1: ContractAddress,
    pub pool: felt252,
    /// The game's config hash (`RatedConfig`).
    pub config: felt252,
    /// The referee key, and the Poseidon hash of the clock settings
    /// (as `clock_presets` keys them). No `rng_tip`: it isn't known yet.
    pub referee: felt252,
    pub clock: felt252,
    pub prover: ContractAddress,
    pub response_seconds: u32,
    pub source: u8,
    pub band_0: u8,
    pub band_1: u8,
    pub matchmaker: felt252,
    pub issued_at: u64,
    pub expires_at: u64,
    pub nonce: felt252,
}
```

- **Digest:** `signing_hash` over `'ARBITER_PAIRING_V1'`, `Rules::TAG`, the
  ratings contract's address and the Serde fields (`digest::<R>(ticket,
  ratings)`). The address stops a ticket
  from being used on another deployment of the same game. Today that is safe
  only because a new ratings contract comes with a new world, and so a new
  channel address (Surround's HARDENING_PLAN T11). Surround's
  `'SURROUND_PAIRING_V1'` tickets stop being valid, which the Sepolia reset
  allows.
- **Scores** count seat 0's half points: 2 won, 1 drew, 0 lost.
  `GameResult.winner` is already seat-based (1 seat 0, 2 seat 1, 0 draw).
- **`check_ticket`** requires both seats nonzero and distinct (today it
  checks only white), that `Rules::pool(ticket.pool)` exists, and that the
  config hash and clock preset are allowed for that pool.
- `TicketUsed` still carries the whole ticket, so `replay.mjs` can rebuild
  every rating. `replay.mjs` reads only the players, bands, source, times and
  steps.
- **Cost of hashes in the ticket:** the terms can no longer be rebuilt from the
  ticket alone, as `ratedTerms(ticket, keys)` does today. The matchmaker sends
  the clock settings and the config with the ticket. A client or the anchor
  daemon then checks three things:
  - the Poseidon hash of the settings is `ticket.clock`;
  - the referee in the terms is `ticket.referee`;
  - the config hash is `ticket.config`.

  This changes `ratedTerms` in the SDK, the anchor daemon's pairing check
  (`offchain/anchors/anchor.ts`) and the `ticket_terms` test helper in
  Surround.

### Rated or not in the signed terms: `RatedConfig`

DESIGN.md decision 4 (2026-10-01) put the ticket's digest in the game's
`Config` (`GoConfig.ticket`), so a player can't open signed rated terms as an
unrated game and leave the ticket unused. The ticket can't also carry a hash of
a config that contains the ticket's own digest, so the hash leaves it out:

```cairo
pub trait RatedConfig<C> {
    /// The ticket's digest; 0 for an unrated game.
    fn ticket(self: @C) -> felt252 {
        0
    }
    /// The same config with another ticket.
    fn with_ticket(self: @C, ticket: felt252) -> C {
        panic_with_felt252('Not a rated game')
    }
}
```

- **The config hash** is Poseidon over the game's `GameRules::TAG`,
  `'ARBITER_CONFIG_V1'` and the Serde fields of `config.with_ticket(0)` (a
  config without a ticket as it is). Serde covers every field, so a game can't
  leave one out of the hash.
- **The guard is in the binding, not each game.** `open_game` and
  `open_game_delegable` take `+RatedConfig<R::Config>` and refuse a nonzero
  `ticket()`. A game without rated play writes
  `impl Unrated of RatedConfig<Config> {}`. Every game gets the guard; a game
  can't forget it. This adds one line to every existing game (the counter,
  Hashfront).
- **`open_rated_game` checks the round trip**:
  `config.with_ticket(0).with_ticket(config.ticket()) == config`. It catches a
  `with_ticket` that changes more than the ticket.

### `arbiter_dojo`

- **`open_rated_game` and `open_rated_game_delegable`**, generic over both
  `GameRules` and `RatingRules`. They check that the terms match the ticket:
  - the config: `ticket()` is the ticket's digest, the round trip holds, and
    the config hash is `ticket.config`;
  - the players: `[player_0, player_1]`;
  - the clock's `referee`, and the hash of its `settings`;
  - randomness: with `REFEREE_RNG` the clock's `rng_tip` must be nonzero, so
    a rated Hashfront game can't use seat-revealed randomness. Without it,
    `rng_tip` must be 0, which replaces Surround's `no_rolls`;
  - the prover and the response window.

  Then they open the game as `open_game` does, call `check_ticket` and write
  `RatedGame`, all in one transaction.
- **`Settlement` and `RatedGame` become `arbiter_dojo` models.** The binding
  writes `Settlement` in `save()` whenever a call leaves the channel SETTLED
  (SETTLED is final, so that is once), so it covers every path that settles,
  including `void` and `roll`. Surround's `note_settlement` covers only its own entrypoints
  today. The route comes from the call's kind:
  - a resignation is `VIA_RESIGN`;
  - a timeout claim is `VIA_TIMEOUT_CLAIM`;
  - everything else is `VIA_TRANSCRIPT`.

  A voided game (`REASON_VOID`, 131) is already `VOID_INVALID` in
  `void_reason`. Every game lists `m_Settlement` in
  `build-external-contracts`, and a game with rated play `m_RatedGame`. Model names keep their namespace, so Surround's
  `dojo_*.toml` writers don't change.
- **`rated_result(world, game_id, ticket) -> Option<GameResult>`** (None
  until the game settles), moved from Surround's `rate`. It reads only arbiter
  state:
  - the result;
  - `started`, or the ticket's `issued_at` for an onchain forfeit that settled
    before any stamp;
  - the settlement;
  - the larger of the anchor's and the candidate's seq.
- **A `rate` helper**, for a game's channel to wrap. It returns the result
  and both seats' ratings, so a game can mirror them; a Dojo mirror event like
  Surround's `PlayerRank`, and a `sync` for it, stay each game's choice.

### What stays runtime policy

Unchanged from `SurroundRatings` v2, now per pool where it was per game:

- channels (active, retiring, removed), matchmaker and referee keys, retirement
  and revocation from a time;
- per pool:
  - allowed clock presets, and allowed config hashes, which replace
    `set_board` and komi;
  - allowed starting bands: a mask over 1..=7, empty until set. This replaces
    `DEFAULT_START_BANDS`, the `0b11100001` mask and `bit()`, which know only
    bands 1–4;
  - the rank offset, bounded by `Pool.max_offset`;
  - anchors;
- provers and the response-window range;
- two-step ownership, `upgrade`, `seal()`, and the 48-hour wait for loosening.

`admin_op` hashes are tagged with `Rules::TAG` instead of
`'SURROUND_ADMIN_V1'`.

### Display

- The component returns μ, φ and `Rules::shown(pool, μ, offset)`. `ranks()`
  takes a pool.
- The default `shown` is the Elo-scale rating `1500 + 173.7178·μ`, rounded
  half to even with the engine's `div`. The offset applies before the clamp,
  and the result is clamped to 0..=65535. It is the number a chess player
  expects.
- Surround's impl returns rank tenths (0 is 30k, 300 is 1d), as
  `rank_tenths` does today.

### What moves where

| Today (Surround) | After |
|---|---|
| `ratings/src/math.cairo` | engine in `arbiter_ratings`; `half_life`, `rank_of`, `MU_T`, bands in Surround's `GoRatingRules` |
| `ratings/src/ratings.cairo` (`SurroundRatings`) | `RatingsComponent`; Surround keeps a `SurroundRatings` contract that embeds it with `GoRatingRules` |
| `ratings/src/ticket.cairo` | `arbiter_ratings::Ticket` |
| `REASON_*` constants duplicated in `ratings.cairo` | imported from `arbiter` |
| `ratings/src/tests/*`, `ratings/audit_fuzz` | engine tests and fuzz properties in arbiter with a test rules impl; Surround keeps the bit-for-bit vectors and the gas test |
| `src/systems/channel.cairo`: `ticket_ratings`, `rated`, `rate`'s body, `note_settlement` | `arbiter_dojo` helpers; Surround's channel wraps them, and keeps `sync`, its `PlayerRank` mirror and `no_rolls` for unrated games |
| `src/models.cairo`: `Settlement`, `RatedGame` | `arbiter_dojo` models; `PlayerRank` stays in Surround; `kifu.cairo` imports them from `arbiter_dojo` |
| `offchain/sdk/src/rating.mjs`, `replay.mjs`, ticket calls in `client.mjs` | `@arbiter/sdk/ratings`, taking a rules object versioned by `params`, so old events still replay after a bump |
| `offchain/generate-rating-vectors.mjs` | stays in Surround, using `@arbiter/sdk/ratings` with Go's rules |
| `offchain/matchmaker`, `offchain/anchors`, `offchain/ratings` (OGS backtest), web | stay in Surround; updated for the new ticket |

## Before and after Surround's launch

These are locked in once real ratings exist, so they must be right before
launch:
- the `(pool, player)` storage keys and the packed player state;
- the `RatingUpdated` and `TicketUsed` shapes, including `pool` as a key;
- what `VERSION` (`params`) means, and the pool ids.

These can change after launch, with care:
- **The ticket digest.** Tickets live 15 minutes at most, but `TicketUsed`
  decoding stays versioned so `replay.mjs` reads every past event.
- **The `arbiter_dojo` helpers and models.** They are per world, and a new
  world redeploys them.

These wait until after launch:
- moving the matchmaker into arbiter, and running chess's own instance;
- chess's pools and settings: a new game deploys its own contract;
- Hashfront's ranked play (`REFEREE_RNG: true`, its config hash);
- an Elo baseline in Surround's backtest, and fitting chess's settings on the
  Lichess database.

## Work plan

1. **License.** An MIT `LICENSE` at the root, and a note in the prover README
   that `prover/patches` keep their upstream license.
2. **`arbiter_ratings` engine.**
   - The math with `RatingRules`, and `Ticket` and its digest.
   - A chess-shaped test impl: flat drift, the Elo display and two pools
     (`blitz`, `rapid`), with every pool checked against the packing bounds.
   - The crate in the workspace and in `scripts/check.sh` (Cairo 2.13.1).
3. **`RatingsComponent`.**
   - Port `SurroundRatings` v2 onto pools and seats: `check_ticket`,
     `rate_game`, `void_reason`, anchors, policy, admin, timelock, seal and
     events, with the Go-shaped items listed under D7 removed.
   - Port the unit, anchor, ticket and audit tests through a test contract
     that embeds the component. Check that a `#[starknet::contract]` under
     `#[cfg(test)]` gets a `TEST_CLASS_HASH`; if not, use an ungated
     `testing` module.
   - Move `audit_fuzz`'s snforge properties, and add an snforge line for them
     to `scripts/check.sh`. It runs snforge only for the adapter today. Call
     `~/.asdf/shims/snforge`, since an older global one may shadow it.
4. **SDK: `@arbiter/sdk/ratings`.**
   - The integer reference update with a rules object.
   - `ticketDigest`, `signTicket`, `decodeTicket`, `configHash` and
     `clockHash`, from which a client checks terms against the ticket.
   - `getPlayerRating`, `getAnchor` and `getPool` with a pool argument,
     `ratingsRules`, and `rateCall` (the ticket names the pool).
   - Replay (`verifyRatings`, `decodeEvent`, `fetchRatingEvents`) with pools.
     It takes the minimum steps, settled games and anchor deviation from the
     rules object of each event's `params` instead of hardcoding them.
   - Cairo vectors generated from it, as today, and the `exports` entry.
5. **`arbiter_dojo`.**
   - `RatedConfig`, with the guard in `open_game` and `open_game_delegable`.
     Add `impl Unrated` to the counter.
   - `Settlement` and `RatedGame`, with `save()` recording settlements.
   - `open_rated_game` (both kinds), `rated_result` and `rate`.
   - A separate rated example, `dojo/examples/rated`: a counter with a ticket
     in its config and two pools, with Dojo tests for each check that
     `ticket_ratings` makes today. A separate example leaves the counter's
     fixtures and context hashes alone, so `check.sh` stays green.
6. **Surround.** Bump the arbiter rev.
   - `GoRatingRules` (pool `'go'`, bands 23k, 17k, 6k and 1k) and a
     `SurroundRatings` contract built from the component.
   - `RatedConfig` for `GoConfig`, and the channel reduced to wrappers.
   - `kifu.cairo` importing the models from `arbiter_dojo`.
   - Delete the moved code.
   - Thin wrappers in the vectors test over the engine and `GoRatingRules`, so
     `vectors.cairo` and `audit_vectors.cairo` stay unchanged.
   - Regenerate `events_for_replay` (read by `replay.test.mjs` and
     `offchain/ratings/audit/replay-check.mjs`) and `SDK_DIGEST` (in
     `test_tickets.cairo` and `client.test.mjs`).
   - The SDK's Go rules object. The matchmaker sends the settings and config
     with each ticket. The anchor daemon and the web check terms against the
     ticket's hashes.
   - `test_rated`, `test_redteam` and `test_gas` passing on the new ticket.
7. **Measure and deploy.** Re-measure `rate_game` on Go's rules, since `drift`
   does `rank_of`'s binary search (today 2.1–2.4M L2 gas in tests). Re-measure
   a rated 9×9 game on Sepolia (today 66.6M). Declaring the class costs about
   42 STRK once per game. Redeploy Surround's world and ratings on Sepolia,
   resetting testers, and run a rated game end to end (`local.py`,
   `sepolia.mjs rated`).
8. **Docs.** DESIGN.md: the layer table, a Ratings section, and the amendment
   to decision 4 (the guard moves into the binding). The docs site: a ratings
   concept page and an API table. Surround's `RANKING_PLAN.md`: a pointer here.
9. **Fable review** of the implementation before mainnet: the component, the
   binding's checks, and Surround's rules impl against today's behavior.

Steps 2–5 are arbiter; 6–7 are Surround and need 2–5. Step 1 can land first.

## Acceptance

- **Surround, bit for bit.** `SurroundRatings` built from the component with
  `GoRatingRules` passes today's `vectors.cairo` and `audit_vectors.cairo`
  unchanged (the 900-case and 400-game parity vectors). The SDK with Go's rules
  regenerates them identically.
- **Not Go-shaped.** The chess-shaped rules impl passes the engine tests and
  the packing bounds, and the rated example rates games in two pools.
- **Same guarantees.** Every red-team regression in Surround's `test_redteam`
  passes, ported to the new ticket. Rated terms can't open through
  `open_game` in any game, and a `with_ticket` that changes more than the
  ticket is refused.
- **Gas.** `rate_game` on Go's rules is within a few percent of today's.

## Decisions

Reviewed by Fable on 2026-10-11; each is agreed as written here.

- **D1. Settings in code, not storage.** No gas cost, no new admin surface,
  and bit-for-bit matching comes for free. Each game declares its own class
  and runs its own upgrades.
- **D2. `RatedConfig`, not a `ticket` field in `Terms`.** Moving it into
  `Terms` would change every terms and context hash, a protocol bump. Decision
  4's protection holds because the guard sits in the binding's `open_game`,
  with the round-trip check and a tagged config hash.
- **D3. The ticket carries hashes**, `referee` and `clock` instead of a
  `TimeControl`, and `config`. A referee's randomness tip isn't known at
  pairing. The cost is that terms ship beside the ticket (see Ticket).
  Nothing is lost for `replay.mjs` or the keeper's hooks, which compare
  digests only.
- **D4. `Settlement` and `RatedGame` in `arbiter_dojo`, written in `save()`.**
  Every game pays one `Settlement` write per settled game, as Surround does
  today. If that ever matters, `settled_at` fits in the 40 bits of
  `deadline`, which every settling path zeroes.
- **D5. A pool is a `felt252` short string.** It costs the same storage-key
  hashing as a `u8` and reads clearly in events.
- **D6. The component's tests run through a test contract in arbiter.**
  Surround keeps the bit-for-bit vectors and the gas test, because they test
  Go's rules.
- **D7. The Go-shaped items, all removed:**
  - colors (now seats) and komi and boards (now config hashes);
  - `no_rolls` (now `REFEREE_RNG`) and its `'Go takes no randomness'` assert;
  - the band list (now `start`), `DEFAULT_START_BANDS`, the `0b11100001`
    mask and `bit()`;
  - rank tenths (now `shown`) and the ±390 offset bound (now `max_offset`);
  - the `'SURROUND_ADMIN_V1'` tag, `ranks()` without a pool, and the
    duplicated `REASON_*`;
  - the white-only seat check, and black/white in `GameResult`'s docs;
  - the SDK's hardcoded constants in `replay.mjs`.
- **D8. New attack surface, compared with v2:**
  - Per-pool policy confusion: closed by keying every policy map and the
    anchors by pool, and checking that the pool exists.
  - Config-hash collisions: would need a Poseidon preimage; the hash is
    tagged, and the round trip is checked.
  - Cross-game tickets: closed by `TAG` in the digest, one deployment per
    game, the channel allowlist and the chain id.
  - Cross-deployment tickets: closed by the ratings address in the digest.
  - Rated terms opened as unrated: closed by the binding's guard.
  - Unrated terms opened as rated: impossible, because the digest is in the
    signed config.

## Open questions

None for implementation. Before chess launches, refit its pools on the
Lichess database, as Surround's settings were fit on OGS's.
