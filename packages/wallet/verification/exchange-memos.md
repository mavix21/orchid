# Known exchange memo registry

`src/server/exchange-memos.server.ts` lists Stellar addresses that are known to need a memo. A send to a listed address without a memo returns `ExternalMemoRequired` carrying the address, exchange name and source. Every other external address accepts an optional text or ID memo. An unlisted address is not known to need a memo; the registry does not claim to be complete.

## Shipped state

The registry is empty. Official Binance and Lemon pages describe memo requirements but publish no verifiable address list. No address was verified, so none was added. Never infer, copy from third-party lists or invent an entry.

## What an entry needs

The `KnownExchangeMemo` schema enforces the first three items. Reviewers must check the fourth.

1. `network` is the network the wallet runs on (`testnet` in this step). A mainnet address never belongs in the testnet registry.
2. `address` is the exact, checksum-valid `G…` account address.
3. `source` is a public HTTPS URL, and `exchange` names the operator.
4. The source is published by the exchange itself (help center, official docs or a SEP-1 `stellar.toml` on its domain). It must name this exact address, say that this network needs a memo there, and be current. Brand-level instructions ("Binance needs a memo") without the address are not enough. Record the date checked in the commit that adds the entry.

Removing an entry needs no evidence. A new entry blocks unsigned drafts to that address that have no memo. It never affects a transfer that is already authorized.
