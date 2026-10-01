// The keeper over HTTP, driven by @arbiter/sdk/keeper: two players moving
// through it, long polls, errors, limits and config loading.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Session, gameIdOf, hex, publicKey, termsTypedData } from '../../sdk/src/index.mjs';
import { KeeperClient } from '../../sdk/src/keeper.mjs';
import { SessionStore, memoryBackend, parse, stringify } from '../../sdk/src/store.mjs';
import { loadConfig, startKeeper } from '../server.mjs';
import {
  CHANNEL, REFEREE_KEY, add, channelOf, counter, copy, fakeChain, keys, played, prefix, terms, timed, walletAddress, walletSign, wallets,
} from './fixtures.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const GAME = { channel: hex(CHANNEL), module: '../../sdk/examples/counter.mjs', export: 'counter' };
const ids = { channel: CHANNEL, game_id: 7n };
/**
 * Terms `t` under their seats' game id, the only one a channel opens them
 * under; with `salt`, another game between the same wallets (fresh session keys).
 */
const own = (t, salt = 0n) => {
  const sessionKeys = salt ? [publicKey(0x100n + salt), publicKey(0x200n + salt)] : t.keys;
  return { ...t, keys: sessionKeys, game_id: gameIdOf(t.players, sessionKeys) };
};

async function keeper(overrides = {}, chain = fakeChain(), env = {}) {
  chain.channels.set(7n, channelOf(played([])));
  const config = await loadConfig({ chain_id: 'SN_TEST', port: 0, poll_seconds: 0, games: [GAME], ...overrides }, { base, env });
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
    const casual = own({ ...terms(), channel: 0n, players: wallets.map(walletAddress) });
    const session = new Session(counter, casual);
    session.move(add(3), keys[0]);
    const message = termsTypedData(counter, casual);
    const [alice, bob] = wallets.map(key => walletSign(key, message));
    await assert.rejects(k.client.register(session), /each seat's wallet signature over its terms/);
    await assert.rejects(k.client.register(session, { authorizations: [alice, alice] }), /Seat 1's wallet did not sign/);
    // Signatures over other terms do not carry over.
    const other = termsTypedData(counter, own(casual, 1n));
    await assert.rejects(k.client.register(session, { authorizations: [walletSign(wallets[0], other), bob] }),
      /Seat 0's wallet did not sign/);
    // No channel onchain is read: the fake chain knows none for this game.
    assert.equal((await k.client.register(session, { authorizations: [alice, bob] })).created, true);
    const kept = parse(await (await fetch(`${k.url}/games/0x0/${hex(casual.game_id)}`)).text());
    assert.deepEqual(kept.authorizations, [alice, bob]);
    assert.equal(kept.seq, 1);
    const info = await (await fetch(`${k.url}/info`)).json();
    assert.deepEqual(info.games.map(g => g.anchored), [true, false]);
  } finally { await k.close(); }
});

test('a game no channel has opened yet is held on its wallets\' signatures', async () => {
  const k = await keeper({ max_open_per_player: 1 });
  try {
    // The game is on the real channel, but the fake chain holds no channel for it.
    const unopened = own({ ...terms(), players: wallets.map(walletAddress) });
    const session = new Session(counter, unopened);
    session.move(add(3), keys[0]);
    const [alice, bob] = wallets.map(key => walletSign(key, termsTypedData(counter, unopened)));
    // An id that isn't its seats' could never open, even signed by both.
    const free = { ...unopened, game_id: 9n };
    await assert.rejects(k.client.register(new Session(counter, free),
      { authorizations: wallets.map(key => walletSign(key, termsTypedData(counter, free))) }), /game id is not its seats/);
    await assert.rejects(k.client.register(session), /each seat's wallet signature over its terms/);
    await assert.rejects(k.client.register(session, { authorizations: [alice, alice] }), /Seat 1's wallet did not sign/);
    // It must start where its terms open: there is no anchor to start from.
    const later = new Session(counter, unopened, { start: session.env, witness: session.witness() });
    await assert.rejects(k.client.register(later, { authorizations: [alice, bob] }), /starts at its opening/);
    // What the game's own opening needs comes along, for the game module's openCall.
    assert.equal((await k.client.register(session, { authorizations: [alice, bob], extras: { ticket: '0x9' } })).created, true);
    const kept = parse(await (await fetch(`${k.url}/games/${hex(CHANNEL)}/${hex(unopened.game_id)}`)).text());
    assert.deepEqual(kept.authorizations, [alice, bob]);
    assert.deepEqual(await k.archive.extras(k.archive.ids(CHANNEL, unopened.game_id)), { ticket: '0x9' });
    // Until it opens, it counts against its wallets' caps.
    const another = own(unopened, 1n);
    const signed = wallets.map(key => walletSign(key, termsTypedData(counter, another)));
    await assert.rejects(k.client.register(new Session(counter, another), { authorizations: signed }),
      e => e.status === 429 && /already plays 1 open games/.test(e.message));
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
    { privateKey: '0x7e', rngSecret: null });
  // A referee that gives randomness names the secret it comes from.
  const rolling = { ...referee, rng_secret_env: 'TEST_RNG_SECRET' };
  const env = { TEST_REFEREE_KEY: '0x7e', TEST_RNG_SECRET: '0x5ec' };
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [GAME], referee: rolling }, { base, env: { TEST_REFEREE_KEY: '0x7e' } }),
    /Set TEST_RNG_SECRET/);
  assert.deepEqual((await loadConfig({ chain_id: 'SN_TEST', games: [GAME], referee: rolling }, { base, env })).referee,
    { privateKey: '0x7e', rngSecret: '0x5ec' });
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [{ ...GAME, export: 'nope' }] }, { base }), /no game codec named nope/);
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [] }, { base }), /at least one/);
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [{ ...GAME, anchored: false, prover: { url: 'x', class_hash: '0x1' } }] }, { base }),
    /no channel to settle on/);
});

test('a wallet that fills its unanchored games can\'t keep the referee off an anchored game', async () => {
  // The attack: a staller fills its per-wallet cap with free unanchored games,
  // hoping the keeper refuses the rated game it would be refereed in.
  const CASUAL = { ...GAME, channel: '0x0', anchored: false };
  const chain = fakeChain();
  const k = await keeper({ games: [GAME, CASUAL], max_open_per_player: 2, referee: { private_key_env: 'REFEREE' } }, chain,
    { REFEREE: hex(REFEREE_KEY) });
  try {
    const players = wallets.map(walletAddress);
    const casual = salt => {
      const casualTerms = own({ ...terms(), channel: 0n, players }, salt);
      const message = termsTypedData(counter, casualTerms);
      return [new Session(counter, casualTerms), { authorizations: wallets.map(key => walletSign(key, message)) }];
    };
    for (const salt of [1n, 2n]) assert.equal((await k.client.register(...casual(salt))).created, true);
    await assert.rejects(k.client.register(...casual(3n)), e => e.status === 429 && /already plays 2 open games/.test(e.message));
    // The anchored, joined game that names the keeper's referee key is admitted, and refereed.
    const rated = new Session(counter, { ...timed(7n), players });
    chain.channels.set(7n, channelOf(rated));
    assert.equal((await k.client.register(rated)).created, true);
    assert.ok(k.archive.referees({ channel: CHANNEL, game_id: 7n }));
    const info = await (await fetch(`${k.url}/info`)).json();
    assert.deepEqual(info.capacity, { open: 3, max_open_games: 10000, reserved_games: 0, free: 9997, free_unreserved: 9997 });
    assert.equal(info.limits.max_open_per_player, 2);
  } finally { await k.close(); }
});

test('a game that could outgrow the entry\'s step cap is refused', async () => {
  const k = await keeper({ games: [{ ...GAME, max_steps: 96 }] });
  try {
    await assert.rejects(k.client.register(played([3])), e => e.status === 409 && /can run to 97 steps/.test(e.message));
  } finally { await k.close(); }
});

test('config: per-entry settings, old names, and the game module\'s hooks', async () => {
  const HOOKED = { ...GAME, module: './hooked.mjs', max_steps: 200, proof_max_steps: 300, start_grace_seconds: 60,
    answer_margin_seconds: 900, world: '0x3031d', namespace: 'counter', from_block: 5 };
  const config = await loadConfig({ chain_id: 'SN_TEST', max_games: 50, max_history_steps: 32, max_steps: 500,
    games: [HOOKED, { ...GAME, channel: '0x0', anchored: false }] }, { base });
  const hooked = config.entries.get(CHANNEL), plain = config.entries.get(0n);
  assert.deepEqual([config.max_open_games, hooked.max_steps, hooked.replay_max_steps, hooked.proof_max_steps,
    hooked.start_grace_seconds, hooked.answer_margin_seconds, hooked.world, hooked.namespace, hooked.from_block],
  [50, 200, 32, 300, 60, 900, 0x3031dn, 'counter', 5]);
  assert.deepEqual(hooked.afterSettle({ game_id: 7n }), [{ contractAddress: '0xabc', entrypoint: 'rate', calldata: ['0x7'] }]);
  assert.equal(hooked.admit({}, timed()), 1);
  assert.deepEqual(hooked.openCall({ game_id: 7n }, terms(), { extras: { code: '0x5' } }),
    { contractAddress: '0xabc', entrypoint: 'open_special', calldata: ['0x5'] });
  assert.deepEqual([plain.max_steps, plain.replay_max_steps, plain.proof_max_steps, plain.start_grace_seconds,
    plain.answer_margin_seconds, plain.admit, plain.afterSettle, plain.world], [500, 32, null, 120, 600, null, null, null]);
  assert.equal(plain.openCall, null);
  assert.deepEqual([hooked.entrypoints.acknowledge, hooked.entrypoints.resume_by_referee, hooked.entrypoints.terms],
    ['acknowledge', 'resume_by_referee', 'terms']);
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [{ ...GAME, world: '0x1' }] }, { base }), /needs its namespace/);
  await assert.rejects(loadConfig({ chain_id: 'SN_TEST', games: [{ ...GAME, export: 'hourglassTime' }] }, { base }),
    /no game codec named hourglassTime/);
});
