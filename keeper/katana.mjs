// The keeper against a local Katana running the counter Dojo world, with real
// transactions: it answers a stale dispute and resolves it into forced play,
// then settles a finished game and resolves it to SETTLED. keeper/katana.sh
// starts Katana and deploys the world first.
//
//   node keeper/katana.mjs RPC_URL CHANNEL_ADDRESS
import assert from 'node:assert/strict';
import { Account, RpcProvider } from 'starknet';
import { ADD, counter } from '../sdk/examples/counter.mjs';
import { Session, decodeTerms, hex, play, publicKey, rngChain } from '../sdk/src/index.mjs';
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

/** Alice creates and Bob joins a counter game; returns its id and a session on the chain's terms. */
async function newGame(seed) {
  const tips = [rngChain(seed, 8)[8], rngChain(seed + 1n, 8)[8]];
  const created = await send(alice, 'create', [20, bob.address, publicKey(sessionKeys[0]), tips[0], owner.address, WINDOW]);
  const trace = await provider.getTransactionTrace(created);
  const id = BigInt(trace.execute_invocation.calls.find(c => BigInt(c.contract_address) === BigInt(CHANNEL)).result[0]);
  await send(bob, 'join', [id, publicKey(sessionKeys[1]), tips[1]]);
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
}, { base: new URL('.', import.meta.url).pathname, env: { KEEPER_PRIVATE_KEY: keeperAccount.privateKey } });
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
  console.log(`keeper actions: ${actions.map(e => `${e.action}${e.via ? `/${e.via}` : ''}${e.ms ? ` ${e.ms} ms` : ''}`).join(', ')}`);
  assert.equal(actions.filter(e => e.outcome === 'failed').length, 0);
} finally {
  await keeper.close();
}
