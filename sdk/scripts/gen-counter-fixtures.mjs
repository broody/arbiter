// Plays scripted counter games through the JS SDK, one untimed and four timed
// (stamped by a referee and ending in a flag): on the standard time rules,
// with byo-yomi, on the hourglass rules of examples/counter/src/hourglass,
// whose clock the referee starts before the first move, and one that takes its
// randomness from the referee.
// Writes the signed transcripts and expected results as Cairo fixtures for
// examples/counter.
// Usage (from the repo root): node sdk/scripts/gen-counter-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { typedData } from 'starknet';
import {
  MOVE_FLAG, MOVE_PLAY, MOVE_PLAY_RANDOM, MOVE_RECOMMIT, MOVE_REVEAL, MOVE_START, REFEREE, RngChain, Session, applyStep,
  checkpointHash, contextHash, flag, hex, liveHash, open, play, playRandom, publicKey, recommit, refereeResumeHash, reveal,
  rngChain, sign, start, stateHash, tag, termsTypedData, tipHash, verify, voidHash,
} from '../src/index.mjs';

import { ADD, GAMBLE, counter, hourglassCounter } from '../examples/counter.mjs';

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

// The timed games. The referee stamps every step, `after` ms after the last.
// `ROLL` is the referee's next hash-chain value, in a game that takes its
// randomness from it (`rng`, the referee's chain).
const refereeKey = 0x7e7e7en;
const ROLL = Symbol('roll');
function timedGame(game_id, settings, script, game = counter, rng = null) {
  const clock = { referee: publicKey(refereeKey), settings, rng_tip: rng ? rng.tip : 0n };
  const session = new Session(game, { ...terms, game_id, clock });
  let now = 1_000_000;
  for (const [scripted, after] of script) {
    now += after;
    const move = scripted === ROLL ? reveal(rng.before(session.env.rng_referee)) : scripted;
    const referee = move.kind === MOVE_FLAG || move.kind === MOVE_START || session.due() === REFEREE;
    const signed = referee ? { step: move } : session.sign(move, privateKeys[session.due()]);
    session.stamp(signed, now, refereeKey);
  }
  return session;
}
const gambleMove = entropy => playRandom({ kind: GAMBLE, amount: 0 }, entropy);
// A 30 s turn allowance, a 60 s bank and a 2 s increment; seat 0 stalls.
const timed = timedGame(2n, { turn_ms: 30000, bank_ms: 60000, increment_ms: 2000, byoyomi: null }, [
  [play({ kind: ADD, amount: 3 }), 0], // seat 0; the first stamp starts the clock
  [gambleMove(chains[1][RNG_LEN - 1]), 40000], // seat 1: all its allowance and 10 s of bank
  [reveal(chains[0][RNG_LEN - 1]), 5000], // seat 0 reveals on its own allowance
  [play({ kind: ADD, amount: 1 }), 20000], // seat 0
  [play({ kind: ADD, amount: 1 }), 1000], // seat 1
  [flag(), 30000 + 64000 + 1], // seat 0's allowance and bank are gone
]);
// Byo-yomi: 10 s of main time, then 3 periods of 5 s; seat 1 stalls in overtime.
const byoyomi = timedGame(3n, { turn_ms: 0, bank_ms: 10000, increment_ms: 0, byoyomi: { periods: 3, period_ms: 5000 } }, [
  [play({ kind: ADD, amount: 3 }), 0], // seat 0
  [play({ kind: ADD, amount: 3 }), 12000], // seat 1: its main time, and 2 s inside its first period
  [play({ kind: ADD, amount: 3 }), 14000], // seat 0: its main time, and 4 s inside a period
  [gambleMove(chains[1][RNG_LEN - 1]), 6000], // seat 1: 6 s of overtime so far
  [reveal(chains[0][RNG_LEN - 1]), 7000], // seat 0's reveal outlasts a period; seat 1's turn, one
  [play({ kind: ADD, amount: 1 }), 3000], // seat 0, inside a period
  [flag(), 10001], // seat 1 outlasts both of its last periods
]);
// Hourglass: 10 s each, and the time a seat uses flows to its opponent. The
// referee starts the clock, so seat 0's first move is timed too.
const hourglass = timedGame(4n, { bank_ms: 10000 }, [
  [start(), 0], // the referee
  [play({ kind: ADD, amount: 3 }), 2000], // seat 0: 8 s left, seat 1 now has 12 s
  [play({ kind: ADD, amount: 3 }), 4000], // seat 1: 8 s left, seat 0 has 12 s
  [play({ kind: ADD, amount: 3 }), 9000], // seat 0: 3 s left, seat 1 has 17 s
  [play({ kind: ADD, amount: 3 }), 1000], // seat 1: 16 s left, seat 0 has 4 s
  [flag(), 4001], // seat 0 runs dry
], hourglassCounter);
// Randomness from the referee: a gamble waits for the referee's value, not the
// other seat's, and that wait is nobody's time.
const REFEREE_RNG_SEED = 0x5eed7en;
const refereeChain = new RngChain(REFEREE_RNG_SEED, RNG_LEN);
const rolled = timedGame(5n, { turn_ms: 30000, bank_ms: 60000, increment_ms: 0, byoyomi: null }, [
  [play({ kind: ADD, amount: 3 }), 0], // seat 0; the first stamp starts the clock
  [gambleMove(chains[1][RNG_LEN - 1]), 10000], // seat 1 gambles: the referee owes a roll
  [ROLL, 0], // the referee, at once
  [gambleMove(chains[0][RNG_LEN - 1]), 5000], // seat 0 gambles
  [ROLL, 700], // a roll that comes late still charges nobody
  [play({ kind: ADD, amount: 1 }), 20000], // seat 1
  [flag(), 30000 + 60000 + 1], // seat 0's allowance and bank are gone
], counter, refereeChain);

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
    case MOVE_START: return 'Move::Start';
    default: return `Move::Resign(${m.seat})`;
  }
}
const g = env.game;
// Each time rule set's settings and clocks as Cairo, serialized with `encode`.
const byoyomiCairo = b => (b == null ? 'Option::None' : `Option::Some(Byoyomi { periods: ${b.periods}, period_ms: ${b.period_ms} })`);
const cairoOf = game => (game === hourglassCounter ? {
  settings: t => `encode(@Hourglass { bank_ms: ${t.bank_ms} })`,
  clock: c => `encode(@HourglassClock { banks: array![${c.banks.join(', ')}].span() })`,
} : {
  settings: t => `encode(@Standard { turn_ms: ${t.turn_ms}, bank_ms: ${t.bank_ms}, increment_ms: ${t.increment_ms}, byoyomi: ${byoyomiCairo(t.byoyomi)} })`,
  clock: c => `encode(@StandardClock { banks: array![${c.banks.join(', ')}].span(), periods: array![${c.periods.join(', ')}].span() })`,
});
const clockCairo = (game, c) => (c == null ? 'Option::None'
  : `Option::Some(Clock { seats: ${cairoOf(game).clock(c.seats)}, used: ${c.used}, stamp: ${c.stamp}, started: ${c.started} })`);
const termsCairo = (t, game = counter) => `Terms {
        chain_id: ${h(t.chain_id)},
        channel: ${h(t.channel)},
        game_id: ${h(t.game_id)},
        prover: ${h(t.prover)},
        response_seconds: ${t.response_seconds},
        clock: ${t.clock == null ? 'Option::None' : `Option::Some(TimeControl { referee: ${h(t.clock.referee)}, settings: ${cairoOf(game).settings(t.clock.settings)}, rng_tip: ${h(t.clock.rng_tip ?? 0n)} })`},
        players: ${spanOf(t.players)},
        keys: ${spanOf(t.keys)},
        rng_tips: ${spanOf(t.rng_tips)},
        config: Config { target: ${t.config.target} },
    }`;
const envelopeCairo = (e, game = counter) => `Envelope {
        seq: ${e.seq},
        transcript: ${h(e.transcript)},
        support_turn: ${e.support_turn},
        last_seat: ${e.last_seat},
        pending: Pending { active: ${bool(e.pending.active)}, seat: ${e.pending.seat}, seq: ${e.pending.seq}, entropy: ${h(e.pending.entropy)} },
        rng_heads: ${spanOf(e.rng_heads)},
        rng_fresh: array![${e.rng_fresh.map(bool).join(', ')}].span(),
        rng_referee: ${h(e.rng_referee)},
        clock: ${clockCairo(game, e.clock)},
        outcome: Outcome { finished: ${bool(e.outcome.finished)}, winner: ${e.outcome.winner}, reason: ${e.outcome.reason} },
        game: Counter { total: ${e.game.total}, next: ${e.game.next}, gamble: ${bool(e.game.gamble)}, winner: ${e.game.winner}, target: ${e.game.target} },
    }`;

// A timed game's fixtures, named `${name}_terms()` and so on.
const timedCairo = (name, session) => `pub fn ${name}_terms() -> Terms<Config> {
    ${termsCairo(session.terms, session.game)}
}

pub fn ${name}_steps() -> Array<Move<Action>> {
    array![
${session.steps.map(s => `        ${moveCairo(s.step)},`).join('\n')}
    ]
}

/// The referee's stamp on each step.
pub fn ${name}_stamps() -> Array<u64> {
    array![${session.steps.map(s => s.stamp).join(', ')}]
}

/// The seat of each step (REFEREE for the referee's own).
pub fn ${name}_seats() -> Array<u8> {
    array![${session.steps.map(s => s.seat).join(', ')}]
}

pub fn ${name}_signatures() -> Array<Signature> {
    array![
${session.steps.map(s => `        ${sig(s.signature)},`).join('\n')}
    ]
}

/// The referee's attestation after each step.
pub fn ${name}_attestations() -> Array<Signature> {
    array![
${session.steps.map(s => `        ${sig(s.attestation)},`).join('\n')}
    ]
}

/// Each seat's last signature among steps \`from..to\`.
pub fn ${name}_finals(from: u32, to: u32) -> Array<Signature> {
    finals_of(${name}_seats(), ${name}_signatures(), from, to)
}

pub fn ${name}_expected() -> Envelope<Counter> {
    ${envelopeCairo(session.env, session.game)}
}
`;

const out = `// Generated by sdk/scripts/gen-counter-fixtures.mjs. Do not edit.
use arbiter::clocks::{Byoyomi, Standard, StandardClock, encode};
use arbiter::{Clock, Envelope, Move, Outcome, Pending, REFEREE, Signature, Terms, TimeControl};
use crate::hourglass::{Hourglass, HourglassClock};
use crate::{Action, Config, Counter};

pub const CONTEXT: felt252 = ${h(context)};
pub const STATE_HASH: felt252 = ${h(finalHash)};
pub const CHECKPOINT: felt252 = ${h(checkpoint)};
/// \`live_hash\` at epoch 3 and deadline 12345, and \`referee_resume_hash\` at
/// epoch 2 from the final state.
pub const LIVE_HASH: felt252 = ${h(liveHash(counter, context, 3, 12345))};
pub const REFEREE_RESUME_HASH: felt252 = ${h(refereeResumeHash(counter, context, 2, finalHash))};
pub const RNG_LEN: u32 = ${RNG_LEN};
pub const SEED_0: felt252 = ${h(chains[0][0])};
pub const SEED_1: felt252 = ${h(chains[1][0])};
pub const REFEREE_KEY: felt252 = ${h(refereeKey)};
pub const TIMED_CONTEXT: felt252 = ${h(timed.context)};
pub const TIMED_STATE_HASH: felt252 = ${h(timed.stateHash())};
pub const BYOYOMI_CONTEXT: felt252 = ${h(byoyomi.context)};
pub const BYOYOMI_STATE_HASH: felt252 = ${h(byoyomi.stateHash())};
pub const HOURGLASS_CONTEXT: felt252 = ${h(hourglass.context)};
pub const HOURGLASS_STATE_HASH: felt252 = ${h(hourglass.stateHash())};
/// The game that takes its randomness from the referee, whose hash chain
/// starts at \`REFEREE_RNG_SEED\` and has \`RNG_LEN\` links.
pub const REFEREE_RNG_SEED: felt252 = ${h(REFEREE_RNG_SEED)};
pub const ROLLED_CONTEXT: felt252 = ${h(rolled.context)};
pub const ROLLED_STATE_HASH: felt252 = ${h(rolled.stateHash())};
/// \`tip_hash\` of that game's tip, and \`void_hash\` at epoch 2 from the final
/// state of the untimed game.
pub const TIP_HASH: felt252 = ${h(tipHash(counter, terms.chain_id, terms.channel, 5n, refereeChain.tip))};
pub const VOID_HASH: felt252 = ${h(voidHash(counter, context, 2, finalHash))};
/// What seat 0's wallet signs to agree to the terms (SNIP-12, termsTypedData in the SDK).
pub const TERMS_MESSAGE: felt252 = ${h(BigInt(typedData.getMessageHash(termsTypedData(counter, terms), terms.players[0])))};

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

${timedCairo('timed', timed)}
${timedCairo('byoyomi', byoyomi)}
${timedCairo('hourglass', hourglass)}
${timedCairo('rolled', rolled)}`;

const target = fileURLToPath(new URL('../../examples/counter/src/fixtures.cairo', import.meta.url));
writeFileSync(target, out);
console.log(`wrote ${target}: ${signed.length} steps, total ${g.total}, winner seat ${env.outcome.winner - 1}; `
  + `timed: ${timed.steps.length} steps, seat ${timed.env.outcome.winner - 1} wins on time; `
  + `byo-yomi: ${byoyomi.steps.length} steps, seat ${byoyomi.env.outcome.winner - 1} wins on time; `
  + `hourglass: ${hourglass.steps.length} steps, seat ${hourglass.env.outcome.winner - 1} wins on time; `
  + `rolled: ${rolled.steps.length} steps, total ${rolled.env.game.total}, seat ${rolled.env.outcome.winner - 1} wins on time`);
