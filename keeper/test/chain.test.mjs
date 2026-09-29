// The keeper's Starknet reads against a fake RPC provider: the joins in a
// Dojo world's events, and a game's terms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash } from 'starknet';
import { encodeTerms, hex } from '../../sdk/src/index.mjs';
import { UPDATES, channelUpdate, dojoSelector, starknetChain } from '../chain.mjs';
import { CHANNEL, counter, timed } from './fixtures.mjs';

const WORLD = 0x3031dn;
const entry = { channel: CHANNEL, game: counter, entrypoints: {}, world: WORLD, namespace: 'surround' };

test('Dojo selectors match a deployed world\'s', () => {
  // surround-ChannelUpdated in Surround's manifest_sepolia.json.
  assert.equal(hex(dojoSelector('surround', 'ChannelUpdated')), '0x37af900a10608bc894a417b0c425feff93fc37f95963ff13498180ffe3cee12');
});

test('joins are read from the world\'s ChannelUpdated events, page by page', async () => {
  // EventEmitted data: [keys.len, game_id, values.len, kind, epoch, seq, status, deadline, state_hash, winner, reason].
  const update = (gameId, kind) => ({ block_number: 12, data: [1n, gameId, 8n, BigInt(kind), 0n, 0n, 1n, 0n, 0xabcn, 0n, 0n].map(hex) });
  const requests = [];
  const provider = {
    getBlockNumber: async () => 20,
    async getEvents(filter) {
      requests.push(filter);
      return filter.continuation_token ? { events: [update(9n, UPDATES.JOINED)] }
        : { events: [update(7n, UPDATES.JOINED), update(8n, UPDATES.DISPUTED)], continuation_token: 'next' };
    },
  };
  const chain = starknetChain({ provider });
  const { games, to } = await chain.joinedGames(entry, 10);
  assert.deepEqual([games.map(g => [g.game_id, g.block]), to], [[[7n, 12], [9n, 12]], 20]);
  const [first, second] = requests;
  assert.deepEqual(first.keys, [[hex(BigInt(hash.getSelectorFromName('EventEmitted')))], [hex(dojoSelector('surround', 'ChannelUpdated'))],
    [hex(CHANNEL)]]);
  assert.deepEqual([first.address, first.from_block, first.to_block, second.continuation_token],
    [hex(WORLD), { block_number: 10 }, { block_number: 20 }, 'next']);
  assert.deepEqual(await chain.joinedGames(entry, 21), { games: [], to: 20 });
  assert.deepEqual(channelUpdate(update(7n, UPDATES.JOINED).data),
    { game_id: 7n, kind: UPDATES.JOINED, epoch: 0, seq: 0, status: 1, deadline: 0, state_hash: 0xabcn, winner: 0, reason: 0 });
});

test('terms are read from the game system', async () => {
  const calls = [];
  const provider = { async callContract(call) { calls.push(call); return encodeTerms(counter, timed()).map(hex); } };
  const chain = starknetChain({ provider });
  assert.deepEqual(await chain.terms({ ...entry, entrypoints: { terms: 'game_terms' } }, 7n), timed());
  assert.deepEqual(calls, [{ contractAddress: hex(CHANNEL), entrypoint: 'game_terms', calldata: ['0x7'] }]);
});
