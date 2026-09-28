// The keeper over HTTP, driven by @referee/sdk/keeper: two players moving
// through it, long polls, errors, limits and config loading.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Session, hex, termsTypedData } from '../../sdk/src/index.mjs';
import { KeeperClient } from '../../sdk/src/keeper.mjs';
import { SessionStore, memoryBackend, parse, stringify } from '../../sdk/src/store.mjs';
import { loadConfig, startKeeper } from '../server.mjs';
import {
  CHANNEL, add, channelOf, counter, copy, fakeChain, keys, played, prefix, terms, walletAddress, walletSign, wallets,
} from './fixtures.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const GAME = { channel: hex(CHANNEL), module: '../../sdk/examples/counter.mjs', export: 'counter' };
const ids = { channel: CHANNEL, game_id: 7n };

async function keeper(overrides = {}, chain = fakeChain()) {
  chain.channels.set(7n, channelOf(played([])));
  const config = await loadConfig({ chain_id: 'SN_TEST', port: 0, poll_seconds: 0, games: [GAME], ...overrides }, { base });
  const logs = [];
  const started = await startKeeper(config, { backend: memoryBackend(), chain, log: e => logs.push(e) });
  return { ...started, logs, client: new KeeperClient(started.url) };
}

test('two players move through the keeper, each verifying the other', async () => {
  const k = await keeper();
  try {
    const aliceStore = new SessionStore(memoryBackend()), bobStore = new SessionStore(memoryBackend());
    const alice = await aliceStore.open(counter, terms());
    await aliceStore.move(alice, add(3), keys[0]);
    assert.equal((await k.client.register(alice)).created, true);

    const bob = await bobStore.open(counter, terms());
    assert.equal((await k.client.pull(bob, { store: bobStore })).length, 1);
    // Alice waits for Bob's reply with a long poll.
    const reply = k.client.pull(alice, { wait: 5, store: aliceStore });
    await bobStore.move(bob, add(2), keys[1]);
    assert.equal((await k.client.send(bob, 1)).accepted, 1);
    assert.deepEqual((await reply).map(r => r.seq), [1]);
    assert.equal(alice.stateHash(), bob.stateHash());
    assert.equal((await aliceStore.load(counter, terms())).env.seq, 2);

    // A new device restores the game from the keeper, verified.
    assert.equal((await k.client.load(counter, ids)).stateHash(), bob.stateHash());
    assert.deepEqual(await k.client.steps(ids, 2, { wait: 1 }), { start: 0, seq: 2, transcript: bob.env.transcript, steps: [] });
    assert.ok(k.logs.some(l => l.path === '/games' && l.status === 200));
  } finally { await k.close(); }
});

test('a client on a replaced branch is told so, and sees the evidence', async () => {
  const k = await keeper();
  try {
    const shared = played([3]);
    const honest = played([2], copy(shared));
    await k.client.register(honest);
    const fork = played([1, 1], copy(shared));
    assert.equal((await k.client.send(fork, 1)).switched, 1);
    await assert.rejects(k.client.send(honest, 1), e => e.status === 409 && e.data.equivocation === true);
    const behind = prefix(honest, 2);
    await assert.rejects(k.client.pull(behind), /The keeper holds another branch at seq 2/);
    // A client still on the shared prefix simply follows the keeper's branch.
    const shared1 = prefix(honest, 1);
    assert.deepEqual((await k.client.pull(shared1)).map(r => r.seq), [1, 2]);
    assert.equal(shared1.stateHash(), fork.stateHash());
    const [evidence] = await k.client.evidence(ids);
    assert.deepEqual([evidence.seq, evidence.seat], [1, 1]);
  } finally { await k.close(); }
});

test('requests are checked, limited and answered with CORS', async () => {
  const chain = fakeChain();
  const k = await keeper({ rate_per_minute: 3, max_body_bytes: 4096 }, chain);
  const raw = (path, init) => fetch(`${k.url}${path}`, init);
  try {
    await assert.rejects(k.client.load(counter, { ...ids, game_id: 8n }), e => e.status === 404);
    assert.equal((await raw('/games/zz/7')).status, 400);
    assert.equal((await raw('/games/0x1/7/steps?from=-1')).status, 400);
    assert.equal((await raw('/nothing')).status, 404);
    assert.equal((await raw('/games/0x1/7/steps', { method: 'PUT' })).status, 405);
    const preflight = await raw('/games', { method: 'OPTIONS' });
    assert.deepEqual([preflight.status, preflight.headers.get('access-control-allow-origin')], [204, '*']);
    assert.equal(await (await raw('/health')).text(), 'ok');
    assert.deepEqual((await (await raw('/info')).json()).games, [{ channel: hex(CHANNEL), tag: 'COUNTER', anchored: true, prover: false }]);

    // Terms the channel does not hold are refused.
    chain.channels.set(7n, { ...chain.channels.get(7n), context: 1n });
    await assert.rejects(k.client.register(played([3])), e => e.status === 409 && /differ/.test(e.message));
    const big = await raw('/games', { method: 'POST', body: stringify({ record: { pad: 'x'.repeat(5000) } }) });
    assert.equal(big.status, 413);
    assert.equal((await raw('/games', { method: 'POST', body: '{' })).status, 400);
    const limited = await raw('/games', { method: 'POST', body: '{}' });
    assert.deepEqual([limited.status, (await limited.json()).error.message], [429, 'Too many requests; retry later']);
  } finally { await k.close(); }
});

test('an unanchored game needs each seat\'s wallet to sign its terms', async () => {
  // Casual games open on no channel: the keeper checks the wallets instead.
  const CASUAL = { ...GAME, channel: '0x0', anchored: false };
  const k = await keeper({ games: [GAME, CASUAL] });
  try {
    const casual = { ...terms(9n), channel: 0n, players: wallets.map(walletAddress) };
    const session = new Session(counter, casual);
    session.move(add(3), keys[0]);
    const message = termsTypedData(counter, casual);
    const [alice, bob] = wallets.map(key => walletSign(key, message));
    await assert.rejects(k.client.register(session), /each seat's wallet signature over its terms/);
    await assert.rejects(k.client.register(session, { authorizations: [alice, alice] }), /Seat 1's wallet did not sign/);
    // Signatures over other terms do not carry over.
    const other = termsTypedData(counter, { ...casual, game_id: 10n });
    await assert.rejects(k.client.register(session, { authorizations: [walletSign(wallets[0], other), bob] }),
      /Seat 0's wallet did not sign/);
    // No channel onchain is read: the fake chain knows none for game 9.
    assert.equal((await k.client.register(session, { authorizations: [alice, bob] })).created, true);
    const kept = parse(await (await fetch(`${k.url}/games/0x0/${hex(9n)}`)).text());
    assert.deepEqual(kept.authorizations, [alice, bob]);
    assert.equal(kept.seq, 1);
    const info = await (await fetch(`${k.url}/info`)).json();
    assert.deepEqual(info.games.map(g => g.anchored), [true, false]);
  } finally { await k.close(); }
});

test('config loads game codecs and needs the account key from the environment', async () => {
  const config = await loadConfig({ chain_id: '0x534e5f54455354', games: [{ ...GAME, entrypoints: { resolve: 'resolve_dispute' },
    prover: { url: 'http://prover', class_hash: '0x5' } }] }, { base });
  const entry = config.entries.get(CHANNEL);
  assert.deepEqual([entry.game.tag, entry.entrypoints.resolve, entry.entrypoints.submit_history, entry.prover.class_hash, config.chain],
    ['COUNTER', 'resolve_dispute', 'submit_history', 5n, terms().chain_id]);
  const account = { address: '0xabc', private_key_env: 'TEST_KEEPER_KEY', max_fee_fri: '1000' };
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [GAME], account }, { base, env: {} }), /Set TEST_KEEPER_KEY/);
  const signing = await loadConfig({ chain_id: 'SN_TEST', games: [GAME], account }, { base, env: { TEST_KEEPER_KEY: '0x1' } });
  assert.deepEqual(signing.account, { address: '0xabc', privateKey: '0x1', maxFee: 1000n });
  const referee = { private_key_env: 'TEST_REFEREE_KEY' };
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [GAME], referee }, { base, env: {} }), /Set TEST_REFEREE_KEY/);
  assert.deepEqual((await loadConfig({ chain_id: 'SN_TEST', games: [GAME], referee }, { base, env: { TEST_REFEREE_KEY: '0x7e' } })).referee,
    { privateKey: '0x7e' });
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [{ ...GAME, export: 'nope' }] }, { base }), /no game codec named nope/);
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [] }, { base }), /at least one/);
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [{ ...GAME, anchored: false, prover: { url: 'x', class_hash: '0x1' } }] }, { base }),
    /no channel to settle on/);
});
