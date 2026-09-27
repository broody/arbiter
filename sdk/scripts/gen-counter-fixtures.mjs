// Plays scripted counter games through the JS SDK, one untimed and one timed
// (stamped by a referee and ending in a flag), and writes the signed
// transcripts and expected results as Cairo fixtures for examples/counter.
// Usage (from the repo root): node sdk/scripts/gen-counter-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MOVE_FLAG, MOVE_PLAY, MOVE_PLAY_RANDOM, MOVE_RECOMMIT, MOVE_REVEAL, Session, applyStep, checkpointHash, contextHash,
  flag, hex, open, play, playRandom, publicKey, recommit, reveal, rngChain, sign, stateHash, tag, verify,
} from '../src/index.mjs';

import { ADD, GAMBLE, counter } from '../examples/counter.mjs';

const RNG_LEN = 8;
const privateKeys = [0x1a2b3cn, 0x4d5e6fn];
const chains = [rngChain(0x5eed0n, RNG_LEN), rngChain(0x5eed1n, RNG_LEN)];
const recommitChain = rngChain(0x5eed2n, RNG_LEN);
const config = { target: 20 };
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 1n, prover: 0xad0b7e5n,
  response_seconds: 3600, clock: null,
  players: [0xa11cen, 0xb0bn],
  keys: privateKeys.map(publicKey),
  rng_tips: chains.map(c => c[RNG_LEN]),
  config,
};
const context = contextHash(counter, terms);

let env = open(counter, terms);
const signed = [];
function step(move) {
  const { env: next, message, seat } = applyStep(counter, context, terms, env, move);
  const signature = sign(message, privateKeys[seat]);
  if (!verify(message, signature, terms.keys[seat])) throw Error('Signature self-check failed');
  signed.push({ step: move, signature, seat });
  env = next;
}
const add = amount => step(play({ kind: ADD, amount }));
const gamble = entropy => step(playRandom({ kind: GAMBLE, amount: 0 }, entropy));

add(3); // seat 0
gamble(chains[1][RNG_LEN - 1]); // seat 1 asks seat 0 for randomness
step(reveal(chains[0][RNG_LEN - 1])); // seat 0
step(recommit(recommitChain[RNG_LEN])); // seat 0 (due again)
gamble(recommitChain[RNG_LEN - 1]); // seat 0
step(reveal(chains[1][RNG_LEN - 2])); // seat 1
while (!env.outcome.finished) add(Math.min(3, env.game.target - env.game.total));

const finalHash = stateHash(counter, env);
const checkpoint = checkpointHash(counter, context, 0, finalHash);
const acks = privateKeys.map(k => sign(checkpoint, k));

// The timed game: a 30 s turn allowance, a 60 s bank and a 2 s increment. The
// referee stamps every step; seat 0 then stalls and is flagged.
const refereeKey = 0x7e7e7en;
const timedTerms = { ...terms, game_id: 2n,
  clock: { referee: publicKey(refereeKey), turn_ms: 30000, bank_ms: 60000, increment_ms: 2000 } };
const timed = new Session(counter, timedTerms);
let now = 1_000_000;
function stamped(move, after) {
  now += after;
  const seat = timed.due();
  return move.kind === MOVE_FLAG
    ? timed.stamp({ step: move }, now, refereeKey)
    : timed.stamp(timed.sign(move, privateKeys[seat]), now, refereeKey);
}
stamped(play({ kind: ADD, amount: 3 }), 0); // seat 0; the first stamp starts the clock
stamped(playRandom({ kind: GAMBLE, amount: 0 }, chains[1][RNG_LEN - 1]), 40000); // seat 1: all its allowance and 10 s of bank
stamped(reveal(chains[0][RNG_LEN - 1]), 5000); // seat 0 reveals on its own allowance
stamped(play({ kind: ADD, amount: 1 }), 20000); // seat 0
stamped(play({ kind: ADD, amount: 1 }), 1000); // seat 1
stamped(flag(), 30000 + 64000 + 1); // seat 0's allowance and bank are gone
const timedEnv = timed.env;

// ---- emit Cairo ----
const h = hex;
const bool = b => (b ? 'true' : 'false');
const spanOf = xs => `array![${xs.map(h).join(', ')}].span()`;
const sig = s => `Signature { r: ${h(s.r)}, s: ${h(s.s)} }`;
function moveCairo(m) {
  switch (m.kind) {
    case MOVE_PLAY: return `Move::Play(Action { kind: ${m.action.kind}, amount: ${m.action.amount} })`;
    case MOVE_PLAY_RANDOM:
      return `Move::PlayRandom((Action { kind: ${m.action.kind}, amount: ${m.action.amount} }, ${h(m.entropy)}))`;
    case MOVE_REVEAL: return `Move::Reveal(${h(m.value)})`;
    case MOVE_RECOMMIT: return `Move::Recommit(${h(m.tip)})`;
    case MOVE_FLAG: return 'Move::Flag';
    default: return `Move::Resign(${m.seat})`;
  }
}
const g = env.game;
const clockCairo = c => (c == null ? 'Option::None'
  : `Option::Some(Clock { banks: array![${c.banks.join(', ')}].span(), turn: ${c.turn}, stamp: ${c.stamp} })`);
const termsCairo = t => `Terms {
        chain_id: ${h(t.chain_id)},
        channel: ${h(t.channel)},
        game_id: ${h(t.game_id)},
        prover: ${h(t.prover)},
        response_seconds: ${t.response_seconds},
        clock: ${t.clock == null ? 'Option::None' : `Option::Some(TimeControl { referee: ${h(t.clock.referee)}, turn_ms: ${t.clock.turn_ms}, bank_ms: ${t.clock.bank_ms}, increment_ms: ${t.clock.increment_ms} })`},
        players: ${spanOf(t.players)},
        keys: ${spanOf(t.keys)},
        rng_tips: ${spanOf(t.rng_tips)},
        config: Config { target: ${t.config.target} },
    }`;
const envelopeCairo = e => `Envelope {
        seq: ${e.seq},
        transcript: ${h(e.transcript)},
        support_turn: ${e.support_turn},
        last_seat: ${e.last_seat},
        pending: Pending { active: ${bool(e.pending.active)}, seat: ${e.pending.seat}, seq: ${e.pending.seq}, entropy: ${h(e.pending.entropy)} },
        rng_heads: ${spanOf(e.rng_heads)},
        clock: ${clockCairo(e.clock)},
        outcome: Outcome { finished: ${bool(e.outcome.finished)}, winner: ${e.outcome.winner}, reason: ${e.outcome.reason} },
        game: Counter { total: ${e.game.total}, next: ${e.game.next}, gamble: ${bool(e.game.gamble)}, winner: ${e.game.winner}, target: ${e.game.target} },
    }`;

const out = `// Generated by sdk/scripts/gen-counter-fixtures.mjs. Do not edit.
use referee::{Clock, Envelope, Move, Outcome, Pending, REFEREE, Signature, Terms, TimeControl};
use crate::{Action, Config, Counter};

pub const CONTEXT: felt252 = ${h(context)};
pub const STATE_HASH: felt252 = ${h(finalHash)};
pub const CHECKPOINT: felt252 = ${h(checkpoint)};
pub const RNG_LEN: u32 = ${RNG_LEN};
pub const SEED_0: felt252 = ${h(chains[0][0])};
pub const SEED_1: felt252 = ${h(chains[1][0])};
pub const REFEREE_KEY: felt252 = ${h(refereeKey)};
pub const TIMED_CONTEXT: felt252 = ${h(timed.context)};
pub const TIMED_STATE_HASH: felt252 = ${h(stateHash(counter, timedEnv))};

pub fn terms() -> Terms<Config> {
    ${termsCairo(terms)}
}

pub fn steps() -> Array<Move<Action>> {
    array![
${signed.map(s => `        ${moveCairo(s.step)},`).join('\n')}
    ]
}

/// The seat that signed each step.
pub fn seats() -> Array<u8> {
    array![${signed.map(s => s.seat).join(', ')}]
}

/// Every step's signature. Replay takes only each seat's last one (\`finals\`).
pub fn signatures() -> Array<Signature> {
    array![
${signed.map(s => `        ${sig(s.signature)},`).join('\n')}
    ]
}

/// Each seat's last signature among steps \`from..to\`, zero for a seat with none.
pub fn finals(from: u32, to: u32) -> Array<Signature> {
    finals_of(seats(), signatures(), from, to)
}

fn finals_of(seats: Array<u8>, signatures: Array<Signature>, from: u32, to: u32) -> Array<Signature> {
    let mut last = array![Signature { r: 0, s: 0 }, Signature { r: 0, s: 0 }];
    for i in from..to {
        let seat = *seats.at(i);
        last = if seat == REFEREE {
            last
        } else if seat == 0 {
            array![*signatures.at(i), *last.at(1)]
        } else {
            array![*last.at(0), *signatures.at(i)]
        };
    }
    last
}

pub fn expected() -> Envelope<Counter> {
    ${envelopeCairo(env)}
}

pub fn acks() -> Array<Signature> {
    array![${acks.map(sig).join(', ')}]
}

pub fn timed_terms() -> Terms<Config> {
    ${termsCairo(timedTerms)}
}

pub fn timed_steps() -> Array<Move<Action>> {
    array![
${timed.steps.map(s => `        ${moveCairo(s.step)},`).join('\n')}
    ]
}

/// The referee's stamp on each timed step.
pub fn timed_stamps() -> Array<u64> {
    array![${timed.steps.map(s => s.stamp).join(', ')}]
}

/// The seat of each timed step (REFEREE for the flag).
pub fn timed_seats() -> Array<u8> {
    array![${timed.steps.map(s => s.seat).join(', ')}]
}

pub fn timed_signatures() -> Array<Signature> {
    array![
${timed.steps.map(s => `        ${sig(s.signature)},`).join('\n')}
    ]
}

/// The referee's attestation after each timed step.
pub fn timed_attestations() -> Array<Signature> {
    array![
${timed.steps.map(s => `        ${sig(s.attestation)},`).join('\n')}
    ]
}

/// Each seat's last signature among timed steps \`from..to\`.
pub fn timed_finals(from: u32, to: u32) -> Array<Signature> {
    finals_of(timed_seats(), timed_signatures(), from, to)
}

pub fn timed_expected() -> Envelope<Counter> {
    ${envelopeCairo(timedEnv)}
}
`;

const target = fileURLToPath(new URL('../../examples/counter/src/fixtures.cairo', import.meta.url));
writeFileSync(target, out);
console.log(`wrote ${target}: ${signed.length} steps, total ${g.total}, winner seat ${env.outcome.winner - 1}; `
  + `timed: ${timed.steps.length} steps, seat ${timedEnv.outcome.winner - 1} wins on time`);
