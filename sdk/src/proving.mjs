// Native SNIP-36 proving of a session through a referee_adapter instance: build
// the virtual transaction the adapter executes, request a proof, check the
// response, and build the `settle` call. Works for any referee game; the game
// comes from the session. Import as `@referee/sdk/proving`.
//
// Adapter convention (referee_adapter::prover): `__execute__(channel, game_id,
// epoch, start, witness, steps, signatures)`, with no witness argument for a
// game whose witness is `()`, and `settle(channel, game_id, epoch, end, acks)`.
// The game's channel exposes `snapshot(game_id)` (referee_dojo::channel::snapshot).
import { RpcProvider } from 'starknet';
import {
  ZERO_SIGNATURE, batchOf, contextHash, decodeChannelGame, decodeSnapshot, encodeBatch, encodeEnvelope, encodeSignatures,
  encodeWitness, felt, hex, proofMessageHash, proofPayload, replay, stateHash, tag,
} from './index.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
const same = (a, b) => a.map(BigInt).join() === b.map(BigInt).join();
const NO_ACKS = [ZERO_SIGNATURE, ZERO_SIGNATURE];

/** Native verification accepts proof bases at least this many blocks behind the head. */
export const NATIVE_CONFIRMATIONS = 10;
/** PROOF1 is the small (log20) path, PROOF2 the large path; referee_adapter accepts both. */
export const PROOF_VERSIONS = ['PROOF1', 'PROOF2'];
/**
 * Virtual OS program attested in Starknet v0.14.4 proof facts (Sepolia, 2026-09).
 * Each adapter instance pins one at deployment; a network OS upgrade needs a new instance.
 */
export const VIRTUAL_OS_PROGRAM = '0x53f6c9fcfd31d27279ff7d7e422b44623550a732b59fe193354a7316a96daa1';

/** The newest block a proof can use as its base, or null while the anchor is too recent. */
export function nativeProofBlock(head, anchorBlock) {
  check(Number.isSafeInteger(head) && head >= 0 && Number.isSafeInteger(anchorBlock) && anchorBlock >= 0, 'Invalid block number');
  return head - NATIVE_CONFIRMATIONS >= anchorBlock ? head - NATIVE_CONFIRMATIONS : null;
}

/** A starknet.js call object. */
export const contractCall = (contract, entrypoint, calldata = []) =>
  ({ contractAddress: hex(contract), entrypoint, calldata: calldata.map(hex) });

/** One JSON-RPC request; throws with `rpcError` or `httpStatus` attached. */
export async function rpc(url, method, params = {}, timeout = 30000) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw Object.assign(Error(`${method}: HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`), { httpStatus: response.status });
  const body = await response.json();
  if (body.error) throw Object.assign(Error(`${method}: ${body.error.message}`), { rpcError: body.error });
  return body.result;
}

/**
 * The channel's `snapshot(game_id)`: terms, epoch, anchor hash and anchor
 * block, checked to identify this game on this chain.
 */
export async function getSnapshot(provider, game, channel, gameId, block = 'latest') {
  const result = decodeSnapshot(game, await provider.callContract(contractCall(channel, 'snapshot', [gameId]), block));
  check(result.terms.channel === felt(channel) && result.terms.game_id === felt(gameId), 'Snapshot identifies another game');
  check(result.terms.chain_id === BigInt(await provider.getChainId()), 'Snapshot identifies another chain');
  return result;
}

/** The adapter's `__execute__` calldata: replay `session` from its start. */
export function provingCalldata(session, epoch) {
  const { game, terms } = session;
  return [felt(terms.channel), felt(terms.game_id), BigInt(epoch), ...encodeEnvelope(game, session.start),
    ...encodeWitness(game, session.startWitness), ...encodeBatch(game, batchOf(session.steps))];
}

/**
 * The virtual INVOKE_V3 the adapter executes to emit the proved transition. It
 * is never broadcast: a prover runs it against a base block and proves it.
 */
export function provingTransaction({ session, epoch, nonce, l2GasLimit = 10_000_000_000 }) {
  const zero = { max_amount: '0x1', max_price_per_unit: '0x0' };
  return { type: 'INVOKE', version: '0x3', sender_address: hex(session.terms.prover),
    calldata: provingCalldata(session, epoch).map(hex), signature: [], nonce: hex(nonce),
    resource_bounds: { l1_gas: zero, l1_data_gas: zero, l2_gas: { max_amount: hex(l2GasLimit), max_price_per_unit: '0x0' } },
    tip: '0x0', paymaster_data: [], account_deployment_data: [], nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1' };
}

/**
 * The channel's `submit_history` call: replay `session` onchain from its start,
 * which must be the channel's anchor (see `rebase`), against each seat's final
 * signature. Without `acks` the end state becomes a dispute candidate.
 */
export const historyCall = (session, epoch, { acks = NO_ACKS, entrypoint = 'submit_history' } = {}) => {
  const { game, terms } = session;
  return contractCall(terms.channel, entrypoint, [terms.game_id, epoch, ...encodeEnvelope(game, session.start),
    ...encodeWitness(game, session.startWitness), ...encodeBatch(game, batchOf(session.steps)), ...encodeSignatures(acks)]);
};

/** A game's `get_channel(game_id)`: referee_dojo's `ChannelGame` model, decoded. */
export async function getChannel(provider, game, channel, gameId, { block = 'latest', entrypoint = 'get_channel' } = {}) {
  return decodeChannelGame(game, await provider.callContract(contractCall(channel, entrypoint, [gameId]), block));
}

/** The adapter's `settle` call, to send with the proof as `validateNativeProof`'s options. */
export const settlementCall = (game, { prover, channel, gameId, epoch, end, acks = NO_ACKS }) =>
  contractCall(prover, 'settle', [channel, gameId, epoch, ...encodeEnvelope(game, end), ...encodeSignatures(acks)]);

/**
 * Check a prover response against the transition we asked for. Returns the
 * `{ proof, proofFacts }` transaction options for `settle`. These checks catch
 * mismatched responses; Starknet verifies the proof itself when it is submitted.
 */
export function validateNativeProof(game, response, { classHash, terms, epoch, startHash, endHash, block, osProgram }) {
  check(typeof response.proof === 'string' && response.proof.length > 0, 'Missing native proof');
  const payload = proofPayload(game, { classHash, prover: terms.prover, terms, context: contextHash(game, terms), epoch, startHash, endHash });
  const messages = response.l2_to_l1_messages;
  check(Array.isArray(messages) && messages.length === 1, 'Unexpected proof messages');
  check(BigInt(messages[0].from_address) === BigInt(terms.prover) && BigInt(messages[0].to_address) === 0n
    && same(messages[0].payload, payload), 'Prover returned another transition');
  const f = response.proof_facts?.map(BigInt);
  check(osProgram !== undefined, 'Supply the adapter\'s pinned OS program');
  check(f?.length === 9 && PROOF_VERSIONS.map(tag).includes(f[0]) && f[1] === tag('VIRTUAL_SNOS')
    && f[2] === BigInt(osProgram) && f[3] === tag('VIRTUAL_SNOS0')
    && f[4] === BigInt(block.block_number) && f[5] === BigInt(block.block_hash) && f[7] === 1n
    && f[8] === proofMessageHash(terms.prover, payload), 'Proof facts do not match the block and transition');
  return { proof: response.proof, proofFacts: response.proof_facts };
}

/**
 * Prove `session` (from the channel's current anchor to its latest step) with
 * a `starknet_proveTransaction` prover, and check the result. Waits up to
 * `waitMs` for the anchor to be NATIVE_CONFIRMATIONS blocks deep.
 *
 * Returns { response, options, block, end, endHash, wall_seconds, call(acks) },
 * where `call(acks)` is the `settle` call to send with `options`.
 */
export async function proveSession({ rpcUrl, provider = new RpcProvider({ nodeUrl: rpcUrl }), proverUrl, session, epoch,
  blockNumber, expectedClassHash, l2GasLimit = 10_000_000_000, waitMs = 120_000 }) {
  check(expectedClassHash !== undefined, 'Supply the allowlisted prover class hash');
  const { game, terms } = session;
  const anchor = await getSnapshot(provider, game, terms.channel, terms.game_id);
  let eligible = null;
  for (const deadline = Date.now() + waitMs; ;) {
    eligible = nativeProofBlock(await provider.getBlockNumber(), anchor.anchor_block);
    if (eligible !== null || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  check(eligible !== null, `Channel anchor is not yet ${NATIVE_CONFIRMATIONS} blocks deep; retry proving later`);
  check(blockNumber === undefined || (Number.isSafeInteger(blockNumber) && blockNumber >= anchor.anchor_block && blockNumber <= eligible),
    `Proof base must follow the anchor and be at least ${NATIVE_CONFIRMATIONS} blocks deep`);
  const block = await provider.getBlockWithTxHashes(blockNumber ?? eligible);
  const current = await getSnapshot(provider, game, terms.channel, terms.game_id, block.block_hash);
  check(current.epoch === epoch, 'Stale proving epoch');
  const startHash = stateHash(game, session.start);
  check(contextHash(game, current.terms) === contextHash(game, terms) && current.anchor_hash === startHash,
    'Session does not start at the chain anchor');
  check(block.block_number >= current.anchor_block, 'Proof base predates anchor');
  const classHash = await provider.getClassHashAt(hex(terms.prover), block.block_hash);
  check(BigInt(classHash) === BigInt(expectedClassHash), 'Unexpected prover class');
  // Replay with every signature verified, as the adapter's final-signature replay would accept it.
  const end = replay(game, terms, session.start, session.startWitness, session.steps).env;
  const endHash = stateHash(game, end);
  check(endHash === session.stateHash(), 'Session output mismatch');
  const transaction = provingTransaction({ session, epoch, l2GasLimit,
    nonce: await provider.getNonceForAddress(hex(terms.prover), block.block_hash) });
  const started = Date.now();
  const response = await rpc(proverUrl, 'starknet_proveTransaction', { block_id: { block_hash: block.block_hash }, transaction }, 600000);
  const wall_seconds = (Date.now() - started) / 1000;
  const osProgram = BigInt((await provider.callContract(contractCall(terms.prover, 'os_program'), block.block_hash))[0]);
  const options = validateNativeProof(game, response, { classHash, terms, epoch, startHash, endHash, block, osProgram });
  return { response, options, block, end, endHash, wall_seconds,
    call: (acks = NO_ACKS) => settlementCall(game, { prover: terms.prover, channel: terms.channel, gameId: terms.game_id, epoch, end, acks }) };
}
