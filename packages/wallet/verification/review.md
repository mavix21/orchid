# Fable review verification

All eight findings were confirmed in the pre-fix code. The inner-hash lookup point required qualification: the RPC reference describes transaction-hash lookup and bounded history but does not explicitly guarantee inner-hash aliasing. A read-only check of the existing testnet opening returned `SUCCESS` when queried by its inner hash. The fix queries both and independently guards expiry with a sufficiently fresh account sequence, so safety does not depend on aliasing.

Sources checked:

- [Official getTransaction reference](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction)
- [Official RPC ledger-entry protocol fields](https://pkg.go.dev/github.com/stellar/go-stellar-sdk/protocols/rpc#LedgerEntryResult), including `extXdr`
- Installed `@stellar/stellar-sdk` 17.4.0 API and XDR types

The read-only public testnet check also confirmed that both the existing verification account and its USDC trustline name the recorded reserve sponsor. It used public transaction evidence only, with no secret reads or transaction submissions.

New regressions cover reopening takeover, claim lease renewal, historical opening redraft, alternate fee-payer inclusion, consumed/stale sequence handling, transient missing reads, sponsor identity, invalid checksums before claims, memo refusal, retained authorized external transfers, username payment settlement, and bounded rotating recovery/transfer queues. Migrations run through the official Effect Postgres migrator against the documented disposable PostgreSQL database.

These fixes have not been exercised with newly submitted testnet transactions or live Circle USDC. The earlier `testnet.json` records the previous implementation's live flows; it is not a fresh verification of this review patch. No production database or deployment was used.
