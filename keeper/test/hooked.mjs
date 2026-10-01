// A game module with the keeper's hooks next to its codec, for the config tests.
export { counter } from '../../sdk/examples/counter.mjs';
/** Timed games get the reserved capacity. */
export const admit = (ids, terms) => (terms.clock ? 1 : 0);
/** A call to send with the resolve that settles a game. */
export const afterSettle = ids => [{ contractAddress: '0xabc', entrypoint: 'rate', calldata: [`0x${ids.game_id.toString(16)}`] }];
/** The call that opens a game no channel holds yet, from what it registered with. */
export const openCall = (ids, terms, { extras }) => ({ contractAddress: '0xabc', entrypoint: 'open_special', calldata: [extras.code] });
