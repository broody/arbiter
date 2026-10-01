// The keeper's Starknet side: read channels, terms, the games opened in a
// world's events and the calls of forced play it did not see, and send
// `submit_history`, `resolve`, proved `settle`, `acknowledge` and
// `resume_by_referee` transactions from the keeper's own account, opening a
// game in the same transaction when no channel holds it yet (`open_game`,
// with its seats' wallet signatures). The keeper holds no player keys; the
// calls it sends are open to anyone, and the only signatures it adds are its
// referee's.
import { Account, RpcProvider, hash } from 'starknet';
import { decodeTerms, felt, hex, poseidon } from '../sdk/src/index.mjs';
import { contractCall, getChannel, historyCall, proveSession, reverted } from '../sdk/src/proving.mjs';

/** Default entrypoint names: arbiter_dojo's (e.g. the counter's system). */
export const ENTRYPOINTS = { get_channel: 'get_channel', submit_history: 'submit_history', resolve: 'resolve',
  acknowledge: 'acknowledge', resume_by_referee: 'resume_by_referee', terms: 'terms', force: 'force', roll: 'roll',
  open_game: 'open_game' };

/** `ChannelUpdated.kind` values (arbiter_dojo::models). 1 and 2, a join and a cancel, are retired. */
export const UPDATES = { OPENED: 0, DISPUTED: 3, RECEIVED: 4, RESOLVED: 5, FORCED: 6, RESUMED: 7,
  TIMED_OUT: 8, RESIGNED: 9, ACKNOWLEDGED: 10, ROLLED: 11, VOIDED: 12 };

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

// A channel in forced play (arbiter::channel::FORCED).
const FORCED = 3;

// The calls a traced transaction made to `channel` for game `gameId` with one
// of `selectors`, in order, however deep (a paymaster or a session wraps them).
function channelCalls(trace, channel, gameId, selectors) {
  const found = [];
  const walk = call => {
    if (!call) return;
    if (call.contract_address !== undefined && BigInt(call.contract_address) === channel
      && selectors.has(BigInt(call.entry_point_selector)) && call.calldata?.length && BigInt(call.calldata[0]) === gameId)
      found.push(call);
    for (const inner of call.calls ?? []) walk(inner);
  };
  walk(trace?.execute_invocation);
  return found;
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
    /** A game's `ChannelGame`, or null when no channel has opened it ('Unknown channel'). */
    async channel(entry, gameId) {
      try { return await getChannel(provider, entry.game, entry.channel, gameId, { entrypoint: names(entry).get_channel }); }
      catch (e) { if (reverted(e, 'Unknown channel')) return null; throw e; }
    },
    /** A game's terms, from its system's `terms(game_id)`. */
    async terms(entry, gameId) { return decodeTerms(entry.game, (await provider.callContract(call(entry, 'terms', [gameId]))).map(BigInt)); },
    /**
     * The games that opened on `entry`'s channel from block `from` on
     * (`ChannelUpdated` of kind OPENED in its `world`, under its `namespace`),
     * and the block scanned to.
     */
    async openedGames(entry, from) {
      const to = await provider.getBlockNumber(), games = [];
      if (from > to) return { games, to: from - 1 };
      const keys = [[hex(EVENT_EMITTED)], [hex(dojoSelector(entry.namespace, 'ChannelUpdated'))], [hex(entry.channel)]];
      let continuation_token;
      do {
        const page = await provider.getEvents({ address: hex(entry.world), from_block: { block_number: from },
          to_block: { block_number: to }, keys, chunk_size: 100, ...(continuation_token ? { continuation_token } : {}) });
        for (const event of page.events) {
          const update = channelUpdate(event.data);
          if (update.kind === UPDATES.OPENED) games.push({ ...update, block: event.block_number });
        }
        continuation_token = page.continuation_token;
      } while (continuation_token);
      return { games, to };
    },
    /**
     * The `force` and `roll` calls that took the channel of game `gameId` to
     * its anchor, oldest first, back to a state `holds(hash)` accepts: each
     * `{ kind, from, to, calldata }`, with `kind` 'force' or 'roll', the state
     * hashes the call started from and reached, and its calldata. Null when
     * the chain does not show that (another transition set the anchor, or
     * forced play did not start from a state `holds` accepts). Reads the
     * world's events, the transactions' traces, and the channel as it was
     * before each call.
     */
    async forcedPlay(entry, gameId, holds, limit = 64) {
      const id = BigInt(gameId), channelAddress = felt(entry.channel);
      const kinds = new Map([[UPDATES.FORCED, 'force'], [UPDATES.ROLLED, 'roll']]);
      const selector = kind => BigInt(hash.getSelectorFromName(names(entry)[kind]));
      const selectors = new Set(['force', 'roll'].map(selector));
      const keys = [[hex(EVENT_EMITTED)], [hex(dojoSelector(entry.namespace, 'ChannelUpdated'))], [hex(entry.channel)]];
      const out = [];
      let channel = await this.channel(entry, gameId);
      while (!holds(channel.anchor.hash)) {
        const block = channel.anchor_block;
        if (channel.status !== FORCED || block === 0 || out.length >= limit) return null;
        // What the channel held before that block, and the game's updates in it.
        const before = await getChannel(provider, entry.game, entry.channel, gameId, { block: block - 1, entrypoint: names(entry).get_channel });
        const updates = [];
        let continuation_token;
        do {
          const page = await provider.getEvents({ address: hex(entry.world), from_block: { block_number: block },
            to_block: { block_number: block }, keys, chunk_size: 100, ...(continuation_token ? { continuation_token } : {}) });
          for (const event of page.events) {
            const update = channelUpdate(event.data);
            if (update.game_id === id) updates.push({ ...update, tx: event.transaction_hash });
          }
          continuation_token = page.continuation_token;
        } while (continuation_token);
        // Each must be a forced step or a posted roll, from the state before to the anchor.
        const calls = new Map(), hops = [];
        let from = felt(before.anchor.hash);
        for (const update of updates) {
          const kind = kinds.get(update.kind);
          if (!kind) return null;
          if (!calls.has(update.tx)) calls.set(update.tx, channelCalls(await provider.getTransactionTrace(update.tx), channelAddress, id, selectors));
          const call = calls.get(update.tx).shift();
          if (!call || BigInt(call.entry_point_selector) !== selector(kind)) return null;
          hops.push({ kind, from, to: update.state_hash, calldata: call.calldata.map(BigInt) });
          from = update.state_hash;
        }
        if (!hops.length || from !== felt(channel.anchor.hash)) return null;
        out.unshift(...hops);
        channel = before;
      }
      return out;
    },
    /** Whether `address`'s account contract accepts `signature` over SNIP-12 `typedData`. */
    verifyMessage: (address, typedData, sig) => provider.verifyMessageInStarknet(typedData, sig, address),
    /** `submit_history`, after `open`, the game's `open_game` call, when no channel holds it yet. */
    submitHistory: (entry, session, epoch, { open = null } = {}) =>
      send([...(open ? [open] : []), historyCall(session, epoch, { entrypoint: names(entry).submit_history })]),
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
    /** A native proof's `settle`, after `open` when no channel holds the game yet. */
    async settle(entry, session, epoch, { open = null } = {}) {
      const proved = await proveSession({ provider, proverUrl: entry.prover.url, session, epoch,
        expectedClassHash: entry.prover.class_hash, waitMs: proveWaitMs });
      if (proved.opening && !open) throw Error('The game is not open: settling it needs its open_game call');
      return send([...(proved.opening ? [open] : []), proved.call()], proved.options);
    },
  };
}
