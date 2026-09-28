// The keeper's Starknet side: read channels, and send `submit_history`,
// `resolve` and proved `settle` transactions from the keeper's own account.
// The keeper holds no player keys; the calls it sends are open to anyone.
import { Account, RpcProvider } from 'starknet';
import { contractCall, getChannel, historyCall, proveSession } from '../sdk/src/proving.mjs';

/** Default entrypoint names: referee_dojo's (e.g. the counter's system). */
export const ENTRYPOINTS = { get_channel: 'get_channel', submit_history: 'submit_history', resolve: 'resolve' };

// Estimated resources times 1.5: estimates skip parts of account validation.
const margin = bounds => Object.fromEntries(Object.entries(bounds).map(([k, r]) =>
  [k, { max_amount: (BigInt(r.max_amount) * 3n + 1n) / 2n, max_price_per_unit: BigInt(r.max_price_per_unit) }]));
const maxFee = bounds => Object.values(bounds).reduce((sum, r) => sum + r.max_amount * r.max_price_per_unit, 0n);

/**
 * A chain for the watcher. `account` is `{ address, privateKey, maxFee }`
 * (maxFee in fri); without it the keeper only watches.
 */
export function starknetChain({ rpcUrl, provider = new RpcProvider({ nodeUrl: rpcUrl }), account, proveWaitMs = 120_000, receiptPollMs = 1000 }) {
  const sender = account ? new Account({ provider, address: account.address, signer: account.privateKey }) : null;
  let tail = Promise.resolve();
  // One transaction at a time: they share the account's nonce.
  const send = (calls, options = {}) => {
    const run = tail.then(async () => {
      const estimate = await sender.estimateInvokeFee(calls, { tip: 0n, skipValidate: false, ...options });
      const resourceBounds = margin(estimate.resourceBounds);
      if (account.maxFee !== undefined && maxFee(resourceBounds) > BigInt(account.maxFee))
        throw Error(`Fee bound ${maxFee(resourceBounds)} exceeds the keeper's max_fee ${account.maxFee}`);
      const { transaction_hash } = await sender.execute(calls, { tip: 0n, ...options, resourceBounds });
      const receipt = await provider.waitForTransaction(transaction_hash, { retryInterval: receiptPollMs });
      if (receipt.isReverted?.() || receipt.execution_status === 'REVERTED')
        throw Error(`Reverted ${transaction_hash}: ${receipt.revert_reason ?? receipt.value?.revert_reason ?? ''}`);
      return transaction_hash;
    });
    tail = run.catch(() => {});
    return run;
  };
  const names = entry => ({ ...ENTRYPOINTS, ...entry.entrypoints });
  return {
    canSend: sender !== null,
    async chainId() { return BigInt(await provider.getChainId()); },
    async now() { return Number((await provider.getBlockWithTxHashes('latest')).timestamp); },
    channel: (entry, gameId) => getChannel(provider, entry.game, entry.channel, gameId, { entrypoint: names(entry).get_channel }),
    /** Whether `address`'s account contract accepts `signature` over SNIP-12 `typedData`. */
    verifyMessage: (address, typedData, signature) => provider.verifyMessageInStarknet(typedData, signature, address),
    submitHistory: (entry, session, epoch) => send([historyCall(session, epoch, { entrypoint: names(entry).submit_history })]),
    resolve: (entry, gameId, epoch) => send([contractCall(entry.channel, names(entry).resolve, [gameId, epoch])]),
    async settle(entry, session, epoch) {
      const proved = await proveSession({ provider, proverUrl: entry.prover.url, session, epoch,
        expectedClassHash: entry.prover.class_hash, waitMs: proveWaitMs });
      return send([proved.call()], proved.options);
    },
  };
}
