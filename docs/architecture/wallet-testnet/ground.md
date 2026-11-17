# Ground: platform constraints the wallet depends on

Each constraint below is relied on by `packages/wallet` or `apps/web`. Each one links to the official page that states it.

## Stellar

- **Reserves.** One base reserve is 0.5 XLM. An account holds two, plus one per subentry such as a trustline, so a wallet with a USDC trustline locks 1.5 XLM. [Lumens](https://developers.stellar.org/docs/learn/fundamentals/lumens).
- **Sponsorship.** A sponsor carries those reserves with a three-operation sandwich: begin sponsoring future reserves, the sponsored operations, end sponsoring. An account created inside it may start with a balance of 0. The sponsor can later revoke sponsorship of entries and signers. [Sponsored reserves](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves).
- **Fee bumps.** A fee-bump transaction wraps a signed inner transaction, and its fee account pays the fee instead of the inner source. The sequence number is still taken from the inner source account. [Fee-bump transactions](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions). The official RPC indexes both the fee-bump and the inner hash ([stellar-rpc source](https://github.com/stellar/stellar-rpc/blob/cacf18510507762fe3ae827f237658d4c61b6456/cmd/stellar-rpc/internal/rpcv1/sqlitedb/transaction.go#L85)); settlement looks up both.
- **Sequence numbers.** A transaction's sequence number must be one greater than the source account's, so one signed transaction applies at most once, and two transactions with the same number exclude each other. [Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions).
- **Time bounds.** A transaction submitted before its `minTime` or after its `maxTime` does not make it into the transaction set. This is what makes expiry provable and gives the recovery transaction its delay. [Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions).
- **Memos.** A memo belongs to the transaction. `MEMO_TEXT` is ASCII or UTF-8 up to 28 bytes; `MEMO_ID` is a 64-bit unsigned integer. [Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions).
- **Submission.** `sendTransaction` returns `PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER` or `ERROR` and does not wait for the result. [sendTransaction](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction). `getTransaction` returns `SUCCESS`, `FAILED` or `NOT_FOUND` with `latestLedgerCloseTime`; only this concludes a transfer. [getTransaction](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction).
- **Testnet reset.** Testnet is reset two to four times a year. The scheduled 2026 reset is December 16, 2026, which `stellar/network.ts` uses as the epoch boundary. [Networks](https://developers.stellar.org/docs/learn/fundamentals/networks).

## Cloudflare

- **Query caching.** Hyperdrive caches read queries by default, with a default `max_age` of 60 seconds. It can be disabled per configuration with `--caching-disabled`, which the wallet requires because its reads are plain `SELECT`s. [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
- **Transaction-mode pooling.** Hyperdrive pools in transaction mode and resets a connection when it returns to the pool. Session-level advisory locks are not supported, so the wallet uses transaction-level locks. [Connection pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/).
- **Cron Triggers.** A cron expression maps to a Worker's `scheduled()` handler, as often as every minute. The sweep runs this way. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- **CPU time.** 10 ms per HTTP request and per Cron Trigger on the Free plan; 5 minutes on Paid (default 30 seconds). [Limits](https://developers.cloudflare.com/workers/platform/limits/).
