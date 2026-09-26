// JS mirror of examples/counter/src/lib.cairo, for fixtures and SDK tests.
import { low128 } from '../src/index.mjs';

export const ADD = 0, GAMBLE = 1, REACHED = 1;

function advance(s, seat, amount) {
  const total = s.total + amount;
  return { total, next: 1 - seat, gamble: false, winner: total >= s.target ? seat + 1 : 0, target: s.target };
}

export const counter = {
  tag: 'COUNTER',
  rulesVersion: 1,
  encodeConfig: c => [BigInt(c.target)],
  decodeConfig: r => ({ target: r.num() }),
  encodeAction: a => [BigInt(a.kind), BigInt(a.amount)],
  encodeState: s => [s.total, s.next, s.gamble ? 1 : 0, s.winner, s.target].map(BigInt),
  init: c => ({ total: 0, next: 0, gamble: false, winner: 0, target: c.target }),
  apply(config, s, seat, a) {
    if (a.kind === ADD) {
      if (a.amount < 1 || a.amount > 3) throw Error('Invalid amount');
      return [advance(s, seat, a.amount), null];
    }
    if (a.kind !== GAMBLE || a.amount !== 0) throw Error('Invalid action');
    return [{ ...s, gamble: true }, 1 - seat];
  },
  resolve(config, s, seed) {
    if (!s.gamble) throw Error('Nothing to resolve');
    return advance({ ...s, gamble: false }, s.next, Number(low128(seed) % 6n) + 1);
  },
  due: s => s.next,
  outcome: s => (s.winner !== 0 ? [s.winner, REACHED] : null),
};
