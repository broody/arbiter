// The keeper's Starknet side: read channels, terms and the joins in a world's
// events, and send `submit_history`, `resolve`, proved `settle`, `acknowledge`
// and `resume_by_referee` transactions from the keeper's own account. The
// keeper holds no player keys; the calls it sends are open to anyone, and the
// only signatures it adds are its referee's.
import { Account, RpcProvider, hash } from 'starknet';
import { decodeTerms, hex, poseidon } from '../sdk/src/index.mjs';
import { contractCall, getChannel, historyCall, proveSession } from '../sdk/src/proving.mjs';

/** Default entrypoint names: referee_dojo's (e.g. the counter's system). */
export const ENTRYPOINTS = { get_channel: 'get_channel', submit_history: 'submit_history', resolve: 'resolve',
  acknowledge: 'acknowledge', resume_by_referee: 'resume_by_referee', terms: 'terms' };

/** `ChannelUpdated.kind` values (referee_dojo::models). */
export const UPDATES = { CREATED: 0, JOINED: 1, CANCELLED: 2, DISPUTED: 3, RECEIVED: 4, RESOLVED: 5, FORCED: 6, RESUMED: 7,
  TIMED_OUT: 8, RESIGNED: 9, ACKNOWLEDGED: 10 };

// A Dojo 1.8 world emits every game event as its own `EventEmitted`.
const EVENT_EMITTED = BigInt(hash.getSelectorFromName('EventEmitted'));

/** Dojo's `bytearray_hash`: Poseidon over a ByteArray's Serde encoding. */
function bytearrayHash(text) {
  const bytes = Buffer.from(text), words = [];
  let i = 0;
  for (; i + 31 <= bytes.length; i += 31) words.push(BigInt(`0x${bytes.subarray(i, i + 31).toString('hex')}`));
  const rest = bytes.subarray(i);
  return poseidon([BigInt(words.length), ...words, rest.length ? BigInt(`0x${rest.toString('hex')}`) : 0n, BigInt(rest.length)]);
}
/** A Dojo resource's selector in a namespace, as `selector_from_tag!`. */
export const dojoSelector = (namespace, name) => poseidon([bytearrayHash(namespace), bytearrayHash(name)]);

/** A `ChannelUpdated` event from its `EventEmitted` data: `[keys.len, ...keys, values.len, ...values]`. */
export function channelUpdate(data) {
  const d = data.map(BigInt), n = Number(d[0]);
  const [game_id] = d.slice(1, 1 + n);
  const [kind, epoch, seq, status, deadline, state_hash, winner, reason] = d.slice(2 + n);
  return { game_id, kind: Number(kind), epoch: Number(epoch), seq: Number(seq), status: Number(status),
    deadline: Number(deadline), state_hash, winner: Number(winner), reason: Number(reason) };
}

// Estimated resources times 1.5: estimates skip parts of account validation.
const margin = bounds => Object.fromEntries(Object.entries(bounds).map(([k, r]) =>
  [k, { max_amount: (BigInt(r.max_amount) * 3n + 1n) / 2n, max_price_per_unit: BigInt(r.max_price_per_unit) }]));
const maxFee = bounds => Object.values(bounds).reduce((sum, r) => sum + r.max_amount * r.max_price_per_unit, 0n);
const signature = s => [s.r, s.s];

/**
 * A chain for the watcher. `account` is `{ address, privateKey, maxFee }`
 * (maxFee in fri); without it the keeper only watches.
 */
export function starknetChain({ rpcUrl, provider = new RpcProvider({ nodeUrl: rpcUrl }), account, proveWaitMs = 120_000, receiptPollMs = 1000 }) {
  const sender = account ? new Account({ provider, address: account.address, signer: account.privateKey }) : null;
  let tail = Promise.resolve();
  // One transaction at a time: they share the account's nonce.
  const queue = task => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
  // Resource bounds for `calls`, within the keeper's max fee; throws if the simulation fails.
  const bounds = async (calls, options = {}) => {
    const estimate = await sender.estimateInvokeFee(calls, { tip: 0n, skipValidate: false, ...options });
    const resourceBounds = margin(estimate.resourceBounds);
    if (account.maxFee !== undefined && maxFee(resourceBounds) > BigInt(account.maxFee))
      throw Error(`Fee bound ${maxFee(resourceBounds)} exceeds the keeper's max_fee ${account.maxFee}`);
    return resourceBounds;
  };
  const send = (calls, options = {}) => queue(async () => {
    const resourceBounds = await bounds(calls, options);
    const { transaction_hash } = await sender.execute(calls, { tip: 0n, ...options, resourceBounds });
    const receipt = await provider.waitForTransaction(transaction_hash, { retryInterval: receiptPollMs });
    if (receipt.isReverted?.() || receipt.execution_status === 'REVERTED')
      throw Error(`Reverted ${transaction_hash}: ${receipt.revert_reason ?? receipt.value?.revert_reason ?? ''}`);
    return transaction_hash;
  });
  const simulates = calls => queue(() => bounds(calls)).then(() => true, () => false);
  const names = entry => ({ ...ENTRYPOINTS, ...entry.entrypoints });
  const call = (entry, name, calldata) => contractCall(entry.channel, names(entry)[name], calldata);
  return {
    canSend: sender !== null,
    provider,
    async chainId() { return BigInt(await provider.getChainId()); },
    async now() { return Number((await provider.getBlockWithTxHashes('latest')).timestamp); },
    blockNumber: () => provider.getBlockNumber(),
    channel: (entry, gameId) => getChannel(provider, entry.game, entry.channel, gameId, { entrypoint: names(entry).get_channel }),
    /** A game's terms, from its system's `terms(game_id)`. */
    async terms(entry, gameId) { return decodeTerms(entry.game, (await provider.callContract(call(entry, 'terms', [gameId]))).map(BigInt)); },
    /**
     * The games that joined on `entry`'s channel from block `from` on
     * (`ChannelUpdated` of kind JOINED in its `world`, under its `namespace`),
     * and the block scanned to.
     */
    async joinedGames(entry, from) {
      const to = await provider.getBlockNumber(), games = [];
      if (from > to) return { games, to: from - 1 };
      const keys = [[hex(EVENT_EMITTED)], [hex(dojoSelector(entry.namespace, 'ChannelUpdated'))], [hex(entry.channel)]];
      let continuation_token;
      do {
        const page = await provider.getEvents({ address: hex(entry.world), from_block: { block_number: from },
          to_block: { block_number: to }, keys, chunk_size: 100, ...(continuation_token ? { continuation_token } : {}) });
        for (const event of page.events) {
          const update = channelUpdate(event.data);
          if (update.kind === UPDATES.JOINED) games.push({ ...update, block: event.block_number });
        }
        continuation_token = page.continuation_token;
      } while (continuation_token);
      return { games, to };
    },
    /** Whether `address`'s account contract accepts `signature` over SNIP-12 `typedData`. */
    verifyMessage: (address, typedData, sig) => provider.verifyMessageInStarknet(typedData, sig, address),
    submitHistory: (entry, session, epoch) => send([historyCall(session, epoch, { entrypoint: names(entry).submit_history })]),
    acknowledge: (entry, gameId, epoch, sig) => send([call(entry, 'acknowledge', [gameId, epoch, ...signature(sig)])]),
    resumeByReferee: (entry, gameId, epoch, sig) => send([call(entry, 'resume_by_referee', [gameId, epoch, ...signature(sig)])]),
    /**
     * `resolve`, with the calls in `after` in the same transaction when a
     * simulation of the bundle succeeds, otherwise in a second one. Returns
     * `{ tx, bundled, after_tx, after_error }`.
     */
    async resolve(entry, gameId, epoch, { after = [] } = {}) {
      const calls = [call(entry, 'resolve', [gameId, epoch])];
      if (!after.length) return { tx: await send(calls) };
      if (await simulates([...calls, ...after])) return { tx: await send([...calls, ...after]), bundled: true };
      const tx = await send(calls);
      try { return { tx, bundled: false, after_tx: await send(after) }; } catch (e) { return { tx, bundled: false, after_error: e.message }; }
    },
    async settle(entry, session, epoch) {
      const proved = await proveSession({ provider, proverUrl: entry.prover.url, session, epoch,
        expectedClassHash: entry.prover.class_hash, waitMs: proveWaitMs });
      return send([proved.call()], proved.options);
    },
  };
}
