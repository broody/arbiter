# Referee

Offchain play and onchain settlement for turn-based games on Starknet.

Players exchange signed moves with no transaction per move. The result settles
onchain through a Stwo proof, or an onchain replay, of the game's own Cairo
rules. Disputes, forced moves and timeouts keep an uncooperative opponent from
stalling a game forever.

A game implements one Cairo trait, `GameRules`, and referee provides the rest:
- signatures and transcripts;
- final-signature replay;
- commit-reveal randomness;
- checkpoints and disputes;
- settlement.

See [DESIGN.md](DESIGN.md).

## Layout

| Path | What |
|---|---|
| `core/` | `referee` crate: the game interface and protocol (Cairo, no Dojo) |
| `examples/counter/` | A minimal game with randomness, and cross-language tests |
| `sdk/` | JS mirror of the protocol hashing and replay, and the fixture generator |
| `scripts/check.sh` | Fixtures, formatting, and tests on Cairo 2.13.1 and 2.18.0 |

## Quick start

```bash
cd sdk && npm install && cd ..
scripts/check.sh
```

Requirements: Scarb 2.13.1 and 2.18.0 (see `.tool-versions`; asdf switches with
`ASDF_SCARB_VERSION`), and Node 22 or later.
