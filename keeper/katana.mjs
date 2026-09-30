// The keeper against a local Katana running the counter Dojo world, with real
// transactions: it answers a stale dispute and resolves it into forced play,
// settles a finished game and resolves it to SETTLED, referees a timed game
// whose stalling seat it flags and settles, and gives another its randomness,
// which the channel replays. keeper/katana.sh starts Katana and deploys the
// world first.
//
//   node keeper/katana.mjs RPC_URL CHANNEL_ADDRESS
import assert from 'node:assert/strict';
import { Account, RpcProvider } from 'starknet';
import { ADD, GAMBLE, counter } from '../sdk/examples/counter.mjs';
import {
  MOVE_REVEAL, REASON_TIMEOUT, REFEREE, Session, decodeTerms, encodeTimeControl, hex, play, playRandom, publicKey, rngChain,
} from '../sdk/src/index.mjs';
import { KeeperClient } from '../sdk/src/keeper.mjs';
import { contractCall, getChannel, rpc } from '../sdk/src/proving.mjs';
import { memoryBackend } from '../sdk/src/store.mjs';
import { loadConfig, startKeeper } from './server.mjs';
import { DISPUTE, FORCED, SETTLED } from './watch.mjs';

const [RPC, CHANNEL] = process.argv.slice(2);
if (!RPC || !CHANNEL) { console.error('usage: node keeper/katana.mjs RPC_URL CHANNEL_ADDRESS'); process.exit(2); }
const provider = new RpcProvider({ nodeUrl: RPC });
// Katana's funded dev accounts: the world owner, two players and the keeper.
const [owner, alice, bob, keeperAccount] = await rpc(RPC, 'dev_predeployedAccounts', []);
const sessionKeys = [0x1a2b3cn, 0x4d5e6fn];
const REFEREE_KEY = 0x7e7e7en;
const WINDOW = 300;

async function send(account, entrypoint, calldata) {
  const signer = new Account({ provider, address: account.address, signer: account.privateKey });
  const { transaction_hash } = await signer.execute([contractCall(CHANNEL, entrypoint, calldata)], { tip: 0n });
  const receipt = await provider.waitForTransaction(transaction_hash, { retryInterval: 500 });
  assert(!receipt.isReverted(), `${entrypoint} reverted: ${receipt.value?.revert_reason}`);
  return transaction_hash;
}
const channel = id => getChannel(provider, counter, CHANNEL, id);
async function until(label, check, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 300))) {
    const value = await check();
    if (value) return value;
  }
  throw Error(`Timed out waiting for ${label}`);
}
const channelWhere = (id, predicate) => async () => { const c = await channel(id); return predicate(c) && c; };
async function passWindow() {
  await rpc(RPC, 'dev_increaseNextBlockTimestamp', [WINDOW + 1]);
  await rpc(RPC, 'dev_generateBlock', []);
}

/**
 * Alice creates and Bob joins a counter game, timed when `clock` is given;
 * returns its id and a session on the chain's terms. A nonzero `clock.rng_tip`
 * asks for the referee's randomness: Bob then joins with the keeper's signed
 * tip for the game.
 */
async function newGame(seed, clock = null) {
  const tips = [rngChain(seed, 8)[8], rngChain(seed + 1n, 8)[8]];
  const time = clock === null ? [1n] : [0n, ...encodeTimeControl(counter, clock)]; // Option<TimeControl>
  const created = await send(alice, 'create', [20, bob.address, publicKey(sessionKeys[0]), tips[0], owner.address, WINDOW, ...time]);
  const trace = await provider.getTransactionTrace(created);
  const id = BigInt(trace.execute_invocation.calls.find(c => BigInt(c.contract_address) === BigInt(CHANNEL)).result[0]);
  const tip = clock?.rng_tip ? await client.tip({ channel: CHANNEL, game_id: id }) : { rng_tip: 0n, signature: { r: 0n, s: 0n } };
  await send(bob, 'join', [id, publicKey(sessionKeys[1]), tips[1], tip.rng_tip, tip.signature.r, tip.signature.s]);
  const terms = decodeTerms(counter, (await provider.callContract(contractCall(CHANNEL, 'terms', [id]))).map(BigInt));
  return { id, session: new Session(counter, terms) };
}
const playTo = (session, amounts) => {
  for (const amount of amounts) session.move(play({ kind: ADD, amount }), sessionKeys[session.due()]);
};

// Any deployed contract can stand in for the prover here: proofs are not used.
await send(owner, 'allow_prover', [owner.classHash, 1]);
const actions = [];
const config = await loadConfig({
  chain_id: hex(BigInt(await provider.getChainId())), rpc_url: RPC, port: 0, poll_seconds: 1,
  games: [{ channel: CHANNEL, module: '../sdk/examples/counter.mjs', export: 'counter' }],
  account: { address: keeperAccount.address, private_key_env: 'KEEPER_PRIVATE_KEY' },
  referee: { private_key_env: 'KEEPER_REFEREE_KEY', rng_secret_env: 'KEEPER_RNG_SECRET' },
}, { base: new URL('.', import.meta.url).pathname,
  env: { KEEPER_PRIVATE_KEY: keeperAccount.privateKey, KEEPER_REFEREE_KEY: hex(REFEREE_KEY), KEEPER_RNG_SECRET: '0x5ec2e7' } });
const keeper = await startKeeper(config, { backend: memoryBackend(), log: e => { if (e.action) actions.push(e); } });
const client = new KeeperClient(keeper.url);

try {
  // A stale dispute: Alice disputes from the opening anchor after four signed steps.
  const a = await newGame(0x5eed0n);
  playTo(a.session, [3, 2, 1, 2]);
  await client.register(a.session);
  await send(alice, 'open_dispute', [a.id, 0]);
  const answered = await until('the keeper to answer', channelWhere(a.id, c => c.status === DISPUTE && c.candidate.seq === 4));
  assert.equal(answered.candidate.hash, a.session.stateHash());
  await passWindow();
  const forced = await until('forced play', channelWhere(a.id, c => c.status === FORCED));
  assert.deepEqual([forced.epoch, forced.anchor.seq, forced.anchor.hash], [1, 4, a.session.stateHash()]);
  console.log(`game ${a.id}: the keeper answered a stale dispute with 4 steps and resolved it into forced play`);

  // A finished game nobody submitted: the keeper settles it and, after the window, resolves it.
  const b = await newGame(0x5eed8n);
  playTo(b.session, [3, 3, 3, 3, 3, 3, 2]);
  await client.register(b.session);
  const candidate = await until('the keeper to settle', channelWhere(b.id, c => c.status === DISPUTE && c.candidate.seq === 7));
  assert.equal(candidate.candidate.hash, b.session.stateHash());
  await passWindow();
  const settled = await until('settlement', channelWhere(b.id, c => c.status === SETTLED));
  assert.deepEqual(settled.result, b.session.env.outcome);
  await until('the keeper to close the game', () => keeper.archive.open().length === 1);
  console.log(`game ${b.id}: the keeper settled it with 7 steps; seat ${settled.result.winner - 1} won`);

  // A timed game the keeper referees: 2 s per turn and no bank. Alice moves;
  // Bob stalls, so the keeper flags him and settles the flag onchain.
  const c = await newGame(0x5eedcn, { referee: publicKey(REFEREE_KEY),
    settings: { turn_ms: 2000, bank_ms: 0, increment_ms: 0, byoyomi: null } });
  await client.register(c.session);
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
  console.log(`game ${c.id}: the keeper refereed it, flagged seat 1 and settled the flag; seat 0 won on time`);

  // A timed game that takes its randomness from the keeper. Bob joined with
  // the keeper's signed tip; he gambles, the keeper rolls as it stamps, and
  // the channel replays the roll when the keeper settles the finished game.
  const d = await newGame(0x5eed10n, { referee: publicKey(REFEREE_KEY), rng_tip: 1n,
    settings: { turn_ms: 60000, bank_ms: 0, increment_ms: 0, byoyomi: null } });
  assert.ok(d.session.terms.clock.rng_tip > 1n);
  await client.register(d.session);
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
  console.log(`game ${d.id}: the keeper rolled a ${rolled} for seat 1's gamble and the channel replayed it; seat ${paid.result.winner - 1} won`);
  console.log(`keeper actions: ${actions.map(e => `${e.action}${e.via ? `/${e.via}` : ''}${e.ms ? ` ${e.ms} ms` : ''}`).join(', ')}`);
  assert.equal(actions.filter(e => e.outcome === 'failed').length, 0);
} finally {
  await keeper.close();
}
