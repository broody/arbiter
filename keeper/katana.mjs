// The keeper against a local Katana running the counter Dojo world, with real
// transactions. Every game opens on its seats' wallet signatures, which
// Katana's accounts check: a seat opens one in the transaction that disputes
// it, and the keeper opens the others in the transaction that settles them.
// The keeper answers a stale dispute and resolves it into forced play,
// settles a finished game and resolves it to SETTLED, referees a timed game
// whose stalling seat it flags and settles, and gives another its randomness,
// which the channel replays. Then it is stopped while a seat gambles onchain in
// forced play, and started again: it reads the forced call back from the
// chain, takes the game back and rolls. keeper/katana.sh starts Katana and
// deploys the world first.
//
//   node keeper/katana.mjs RPC_URL CHANNEL_ADDRESS WORLD_ADDRESS
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Account, RpcProvider, stark } from 'starknet';
import { ADD, GAMBLE, counter } from '../sdk/examples/counter.mjs';
import {
  MOVE_REVEAL, REASON_TIMEOUT, REFEREE, Session, ZERO_SIGNATURE, applySteps, encodeEnvelope, encodeSteps, hex, play,
  playRandom, publicKey, rngChain, termsTypedData,
} from '../sdk/src/index.mjs';
import { KeeperClient } from '../sdk/src/keeper.mjs';
import { contractCall, getChannel, openGameCall, reverted, rpc } from '../sdk/src/proving.mjs';
import { memoryBackend } from '../sdk/src/store.mjs';
import { loadConfig, startKeeper } from './server.mjs';
import { ACTIVE, DISPUTE, FORCED, SETTLED } from './watch.mjs';

const [RPC, CHANNEL, WORLD] = process.argv.slice(2);
if (!RPC || !CHANNEL || !WORLD) { console.error('usage: node keeper/katana.mjs RPC_URL CHANNEL_ADDRESS WORLD_ADDRESS'); process.exit(2); }
const provider = new RpcProvider({ nodeUrl: RPC });
// Katana's funded dev accounts: the world owner, two players and the keeper.
const [owner, alice, bob, keeperAccount] = await rpc(RPC, 'dev_predeployedAccounts', []);
const sessionKeys = [0x1a2b3cn, 0x4d5e6fn];
const REFEREE_KEY = 0x7e7e7en;
const WINDOW = 300;

const wallet = account => new Account({ provider, address: account.address, signer: account.privateKey });
/** One transaction from `account` with `calls`, in order. */
async function sendCalls(account, calls) {
  const { transaction_hash } = await wallet(account).execute(calls, { tip: 0n });
  const receipt = await provider.waitForTransaction(transaction_hash, { retryInterval: 500 });
  assert(!receipt.isReverted(), `${calls.map(c => c.entrypoint).join(' + ')} reverted: ${receipt.value?.revert_reason}`);
  return transaction_hash;
}
const send = (account, entrypoint, calldata) => sendCalls(account, [contractCall(CHANNEL, entrypoint, calldata)]);
// A game's channel, or null before anyone opens it.
async function channel(id) {
  try { return await getChannel(provider, counter, CHANNEL, id); }
  catch (e) { if (reverted(e, 'Unknown channel')) return null; throw e; }
}
async function until(label, check, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 300))) {
    const value = await check();
    if (value) return value;
  }
  throw Error(`Timed out waiting for ${label}`);
}
const channelWhere = (id, predicate) => async () => { const c = await channel(id); return c !== null && predicate(c) && c; };
async function passWindow() {
  await rpc(RPC, 'dev_increaseNextBlockTimestamp', [WINDOW + 1]);
  await rpc(RPC, 'dev_generateBlock', []);
}

const CHAIN = BigInt(await provider.getChainId());
/**
 * Alice and Bob agree to a counter game, timed when `clock` is given: each
 * wallet signs its terms, and nothing is onchain yet. A `clock.rng_tip` asks
 * for the referee's randomness: the terms then carry the keeper's tip for the
 * game. Returns its id, a session, the wallets' signatures and its
 * `open_game` call.
 */
async function newGame(seed, clock = null) {
  const id = BigInt(`0x${randomBytes(16).toString('hex')}`), ids = { channel: CHANNEL, game_id: id };
  const tip = clock?.rng_tip ? await client.tip(ids, { config: { target: 20 } }) : null;
  const terms = {
    chain_id: CHAIN, channel: BigInt(CHANNEL), game_id: id, prover: BigInt(owner.address), response_seconds: WINDOW,
    clock: clock && { ...clock, rng_tip: tip?.rng_tip ?? 0n },
    players: [BigInt(alice.address), BigInt(bob.address)], keys: sessionKeys.map(publicKey),
    rng_tips: [rngChain(seed, 8)[8], rngChain(seed + 1n, 8)[8]], config: { target: 20 },
  };
  const authorizations = await Promise.all([alice, bob].map(async a =>
    stark.formatSignature(await wallet(a).signMessage(termsTypedData(counter, terms)))));
  const open = openGameCall(counter, terms, authorizations, { refereeSignature: tip?.signature ?? ZERO_SIGNATURE });
  return { id, session: new Session(counter, terms), authorizations, open };
}
const register = game => client.register(game.session, { authorizations: game.authorizations });
const playTo = (session, amounts) => {
  for (const amount of amounts) session.move(play({ kind: ADD, amount }), sessionKeys[session.due()]);
};

// Any deployed contract can stand in for the prover here: proofs are not used.
await send(owner, 'allow_prover', [owner.classHash, 1]);
const actions = [];
const config = await loadConfig({
  chain_id: hex(BigInt(await provider.getChainId())), rpc_url: RPC, port: 0, poll_seconds: 1,
  games: [{ channel: CHANNEL, module: '../sdk/examples/counter.mjs', export: 'counter', world: WORLD, namespace: 'counter' }],
  account: { address: keeperAccount.address, private_key_env: 'KEEPER_PRIVATE_KEY' },
  referee: { private_key_env: 'KEEPER_REFEREE_KEY', rng_secret_env: 'KEEPER_RNG_SECRET' },
}, { base: new URL('.', import.meta.url).pathname,
  env: { KEEPER_PRIVATE_KEY: keeperAccount.privateKey, KEEPER_REFEREE_KEY: hex(REFEREE_KEY), KEEPER_RNG_SECRET: '0x5ec2e7' } });
// One store for the keeper's two lives.
const backend = memoryBackend(), log = e => { if (e.action) actions.push(e); };
let keeper = await startKeeper(config, { backend, log });
let client = new KeeperClient(keeper.url);

try {
  // A stale dispute: after four signed steps, Alice opens the game and
  // disputes it from the opening anchor, in one transaction.
  const a = await newGame(0x5eed0n);
  playTo(a.session, [3, 2, 1, 2]);
  await register(a);
  await sendCalls(alice, [a.open, contractCall(CHANNEL, 'open_dispute', [a.id, 0])]);
  const answered = await until('the keeper to answer', channelWhere(a.id, c => c.status === DISPUTE && c.candidate.seq === 4));
  assert.equal(answered.candidate.hash, a.session.stateHash());
  await passWindow();
  const forced = await until('forced play', channelWhere(a.id, c => c.status === FORCED));
  assert.deepEqual([forced.epoch, forced.anchor.seq, forced.anchor.hash], [1, 4, a.session.stateHash()]);
  console.log(`game ${hex(a.id)}: Alice opened and disputed it; the keeper answered with 4 steps and resolved it into forced play`);

  // A finished game nobody opened: the keeper opens it in the transaction that
  // submits it and, after the window, resolves it.
  const b = await newGame(0x5eed8n);
  playTo(b.session, [3, 3, 3, 3, 3, 3, 2]);
  await register(b);
  const candidate = await until('the keeper to settle', channelWhere(b.id, c => c.status === DISPUTE && c.candidate.seq === 7));
  assert.equal(candidate.candidate.hash, b.session.stateHash());
  await passWindow();
  const settled = await until('settlement', channelWhere(b.id, c => c.status === SETTLED));
  assert.deepEqual(settled.result, b.session.env.outcome);
  await until('the keeper to close the game', () => keeper.archive.open().length === 1);
  console.log(`game ${hex(b.id)}: the keeper opened and settled it with 7 steps; seat ${settled.result.winner - 1} won`);

  // A timed game the keeper referees: 2 s per turn and no bank. Alice moves;
  // Bob stalls, so the keeper flags him and settles the flag onchain.
  const c = await newGame(0x5eedcn, { referee: publicKey(REFEREE_KEY),
    settings: { turn_ms: 2000, bank_ms: 0, increment_ms: 0, byoyomi: null } });
  await register(c);
  c.session.sign(play({ kind: ADD, amount: 3 }), sessionKeys[0]);
  await client.submit(c.session);
  assert.ok(c.session.steps[0].stamp > 0);
  const flagged = await until('the keeper to flag and submit', channelWhere(c.id, x => x.status === DISPUTE && x.candidate.seq === 2));
  await client.pull(c.session);
  assert.equal(flagged.candidate.hash, c.session.stateHash());
  await passWindow();
  const timedOut = await until('settlement', channelWhere(c.id, x => x.status === SETTLED));
  assert.deepEqual(timedOut.result, { finished: true, winner: 1, reason: REASON_TIMEOUT });
  await until('the keeper to close the game', () => keeper.archive.open().length === 1);
  console.log(`game ${hex(c.id)}: the keeper refereed it, flagged seat 1 and opened it to settle the flag; seat 0 won on time`);

  // A timed game that takes its randomness from the keeper: its terms carry
  // the keeper's tip. Bob gambles, the keeper rolls as it stamps, and the
  // channel replays the roll when the keeper opens and settles the game,
  // with its own signature over the tip.
  const d = await newGame(0x5eed10n, { referee: publicKey(REFEREE_KEY), rng_tip: 1n,
    settings: { turn_ms: 60000, bank_ms: 0, increment_ms: 0, byoyomi: null } });
  assert.ok(d.session.terms.clock.rng_tip > 1n);
  await register(d);
  const move = async step => {
    d.session.sign(step, sessionKeys[d.session.due()]);
    await client.submit(d.session);
  };
  await move(play({ kind: ADD, amount: 3 }));
  await move(playRandom({ kind: GAMBLE, amount: 0 }, rngChain(0x5eed11n, 8)[7]));
  const roll = d.session.steps.at(-1);
  assert.deepEqual([roll.step.kind, roll.seat, d.session.env.pending.active], [MOVE_REVEAL, REFEREE, false]);
  const rolled = d.session.env.game.total - 3;
  while (!d.session.env.outcome.finished) await move(play({ kind: ADD, amount: Math.min(3, 20 - d.session.env.game.total) }));
  const replayed = await until('the keeper to settle', channelWhere(d.id, x => x.status === DISPUTE && x.candidate.seq === d.session.env.seq));
  assert.equal(replayed.candidate.hash, d.session.stateHash());
  await passWindow();
  const paid = await until('settlement', channelWhere(d.id, x => x.status === SETTLED));
  assert.deepEqual(paid.result, d.session.env.outcome);
  await until('the keeper to close the game', () => keeper.archive.open().length === 1);
  console.log(`game ${hex(d.id)}: the keeper rolled a ${rolled} for seat 1's gamble and the channel replayed it; seat ${paid.result.winner - 1} won`);

  // The keeper is down while a game it gives randomness goes to forced play,
  // where Alice gambles onchain: the channel waits for the referee's roll.
  const rolledClock = { referee: publicKey(REFEREE_KEY), rng_tip: 1n,
    settings: { turn_ms: 60000, bank_ms: 0, increment_ms: 0, byoyomi: null } };
  const e = await newGame(0x5eed20n, rolledClock);
  await register(e);
  await keeper.close();
  await sendCalls(alice, [e.open, contractCall(CHANNEL, 'open_dispute', [e.id, 0])]);
  await passWindow();
  await send(bob, 'resolve', [e.id, 0]);
  const gamble = [playRandom({ kind: GAMBLE, amount: 0 }, rngChain(0x5eed20n, 8)[7])];
  await send(alice, 'force', [e.id, 1, ...encodeEnvelope(counter, e.session.start), ...encodeSteps(counter, gamble)]);
  const paused = await channel(e.id);
  assert.deepEqual([paused.status, paused.epoch, paused.anchor.due], [FORCED, 2, REFEREE]);
  // Back up, the keeper reads the forced call from the chain, takes the game
  // back and rolls, though no seat told it what was played.
  keeper = await startKeeper(config, { backend, log });
  client = new KeeperClient(keeper.url);
  const back = await until('the keeper to take the game back', channelWhere(e.id, x => x.status === ACTIVE && x.epoch === 3));
  const waiting = applySteps(counter, e.session.context, e.session.terms, e.session.start, null, gamble);
  const resumed = new Session(counter, e.session.terms, { start: waiting });
  assert.equal(back.anchor.hash, resumed.stateHash());
  await until('the roll', async () => { await client.pull(resumed); return resumed.steps.length > 0; });
  assert.deepEqual([resumed.steps[0].step.kind, resumed.steps[0].seat, resumed.env.pending.active], [MOVE_REVEAL, REFEREE, false]);
  console.log(`game ${hex(e.id)}: the keeper, down while seat 0 gambled onchain, followed the forced call, resumed the game and rolled a ${resumed.env.game.total}`);
  console.log(`keeper actions: ${actions.map(e => `${e.action}${e.via ? `/${e.via}` : ''}${e.ms ? ` ${e.ms} ms` : ''}`).join(', ')}`);
  assert.equal(actions.filter(e => e.outcome === 'failed').length, 0);
} finally {
  await keeper.close();
}
