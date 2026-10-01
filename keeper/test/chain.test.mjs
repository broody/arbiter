// The keeper's Starknet reads against a fake RPC provider: the joins in a
// Dojo world's events, a game's terms, and the calls of forced play.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash } from 'starknet';
import { encodeTerms, hex } from '../../sdk/src/index.mjs';
import { UPDATES, channelUpdate, dojoSelector, starknetChain } from '../chain.mjs';
import { FORCED } from '../watch.mjs';
import { CHANNEL, counter, timed } from './fixtures.mjs';

const WORLD = 0x3031dn;
const entry = { channel: CHANNEL, game: counter, entrypoints: {}, world: WORLD, namespace: 'surround' };

test('Dojo selectors match a deployed world\'s', () => {
  // surround-ChannelUpdated in Surround's manifest_sepolia.json.
  assert.equal(hex(dojoSelector('surround', 'ChannelUpdated')), '0x37af900a10608bc894a417b0c425feff93fc37f95963ff13498180ffe3cee12');
});

test('openings are read from the world\'s ChannelUpdated events, page by page', async () => {
  // EventEmitted data: [keys.len, game_id, values.len, kind, epoch, seq, status, deadline, state_hash, winner, reason].
  const update = (gameId, kind) => ({ block_number: 12, data: [1n, gameId, 8n, BigInt(kind), 0n, 0n, 1n, 0n, 0xabcn, 0n, 0n].map(hex) });
  const requests = [];
  const provider = {
    getBlockNumber: async () => 20,
    async getEvents(filter) {
      requests.push(filter);
      return filter.continuation_token ? { events: [update(9n, UPDATES.OPENED)] }
        : { events: [update(7n, UPDATES.OPENED), update(8n, UPDATES.DISPUTED)], continuation_token: 'next' };
    },
  };
  const chain = starknetChain({ provider });
  const { games, to } = await chain.openedGames(entry, 10);
  assert.deepEqual([games.map(g => [g.game_id, g.block]), to], [[[7n, 12], [9n, 12]], 20]);
  const [first, second] = requests;
  assert.deepEqual(first.keys, [[hex(BigInt(hash.getSelectorFromName('EventEmitted')))], [hex(dojoSelector('surround', 'ChannelUpdated'))],
    [hex(CHANNEL)]]);
  assert.deepEqual([first.address, first.from_block, first.to_block, second.continuation_token],
    [hex(WORLD), { block_number: 10 }, { block_number: 20 }, 'next']);
  assert.deepEqual(await chain.openedGames(entry, 21), { games: [], to: 20 });
  assert.deepEqual(channelUpdate(update(7n, UPDATES.OPENED).data),
    { game_id: 7n, kind: UPDATES.OPENED, epoch: 0, seq: 0, status: 1, deadline: 0, state_hash: 0xabcn, winner: 0, reason: 0 });
});

test('terms are read from the game system', async () => {
  const calls = [];
  const provider = { async callContract(call) { calls.push(call); return encodeTerms(counter, timed()).map(hex); } };
  const chain = starknetChain({ provider });
  assert.deepEqual(await chain.terms({ ...entry, entrypoints: { terms: 'game_terms' } }, 7n), timed());
  assert.deepEqual(calls, [{ contractAddress: hex(CHANNEL), entrypoint: 'game_terms', calldata: ['0x7'] }]);
});

test('forced play is read back from the chain, call by call, to a state the keeper holds', async () => {
  // The channel at three blocks: forced play from state 0xa0 (block 30), a forced
  // step to 0xa1 (block 40), then a forced gamble and a posted roll to 0xa3 (block 50).
  const ref = hash => [hash, 5n, 3n, 1n, 0n, 0n, 0n];
  const stored = (anchor, block) => [7n, 0xa11cen, 0xb0bn, 1n, 2n, 3n, 4n, 0xad0b7e5n, 1n, 20n, BigInt(FORCED), 3n, 0xc0n, 3600n,
    0n, 0n, 0n, ...ref(anchor), ...ref(anchor), BigInt(block), BigInt(block), 900n, 0n, 0n, 0n, 0n, 0n].map(hex);
  const at = block => (block === 'latest' || block >= 50 ? stored(0xa3n, 50) : block >= 40 ? stored(0xa1n, 40) : stored(0xa0n, 30));
  const update = (gameId, kind, state, tx) => ({ transaction_hash: tx,
    data: [1n, gameId, 8n, BigInt(kind), 0n, 0n, BigInt(FORCED), 0n, state, 0n, 0n].map(hex) });
  const events = { 40: [update(7n, UPDATES.FORCED, 0xa1n, '0x40')],
    50: [update(8n, UPDATES.FORCED, 0xbbn, '0x4f'), update(7n, UPDATES.FORCED, 0xa2n, '0x50'), update(7n, UPDATES.ROLLED, 0xa3n, '0x51')] };
  const call = (name, calldata, address = CHANNEL) =>
    ({ contract_address: hex(address), entry_point_selector: hash.getSelectorFromName(name), calldata: calldata.map(hex), calls: [] });
  // The calls sit under the accounts' own, as a paymaster or a session wraps them.
  const traces = {
    '0x40': { execute_invocation: { calls: [call('force', [7n, 1n, 0x11n])] } },
    '0x50': { execute_invocation: { calls: [{ calls: [call('force', [8n, 1n, 0x99n]), call('force_turn', [7n, 2n, 0x22n])] }] } },
    '0x51': { execute_invocation: { calls: [call('roll', [7n, 3n, 0x33n], 0xdeadn), call('roll', [7n, 3n, 0x33n])] } },
  };
  const reads = [];
  const provider = {
    async callContract(c, block = 'latest') { reads.push(block); return at(block); },
    async getEvents(filter) { return { events: events[filter.from_block.block_number] ?? [] }; },
    async getTransactionTrace(tx) { return traces[tx]; },
  };
  const chain = starknetChain({ provider });
  const forcing = { ...entry, entrypoints: { force: 'force_turn' } };
  const calls = await chain.forcedPlay(forcing, 7n, held => held === 0xa1n);
  assert.deepEqual(calls, [
    { kind: 'force', from: 0xa1n, to: 0xa2n, calldata: [7n, 2n, 0x22n] },
    { kind: 'roll', from: 0xa2n, to: 0xa3n, calldata: [7n, 3n, 0x33n] },
  ]);
  assert.deepEqual(reads, ['latest', 49]);
  // Further back, to the state forced play began from.
  traces['0x40'].execute_invocation.calls[0] = call('force_turn', [7n, 1n, 0x11n]);
  const all = await chain.forcedPlay(forcing, 7n, held => held === 0xa0n);
  assert.deepEqual(all.map(c => [c.kind, c.from, c.to]), [['force', 0xa0n, 0xa1n], ['force', 0xa1n, 0xa2n], ['roll', 0xa2n, 0xa3n]]);
  // Nothing to read once the keeper holds the anchor; null when the trail ends elsewhere.
  assert.deepEqual(await chain.forcedPlay(forcing, 7n, () => true), []);
  assert.equal(await chain.forcedPlay(forcing, 7n, () => false), null);
  assert.equal(await chain.forcedPlay(entry, 7n, held => held === 0xa1n), null);
});
