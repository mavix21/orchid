# Sketch: candidates

Part of the [core wallet flow sketch](sketch.md). The three designs considered and why one was kept.

## 1. Three candidates

Each candidate is a whole design, starting from what the UI calls.

### A. Server ledger

The server keeps a durable record of every transfer and is the only thing that talks to Stellar. The phone holds the key and nothing else.

```ts
// UI
const outcome = await wallet.send("@maria", "5.00");
```

Behind that call, the phone asks the server for a transaction, checks that it does what the user asked, signs it, and hands the signature back. The server wraps it so the sponsor pays the fee, stores it, submits it and follows it to its end. If the app closes after the signature is handed over, the server finishes alone.

### B. Device outbox

The phone builds, signs and submits transactions itself, straight to Stellar. It keeps a durable outbox in IndexedDB. The server is a username directory plus a co-signer for sponsorship and fees.

```ts
// UI
const outcome = await wallet.send("@maria", "5.00");
// inside: directory.resolve → build → sponsor.cosign(envelope) → outbox.put → rpc.send → rpc.poll
```

The server stores no transfers. History comes from the chain.

### C. Contract account

Each wallet is a smart contract controlled by a passkey. A relayer service submits and pays for every action.

```ts
// UI
const outcome = await wallet.send("@maria", "5.00");
// inside: build contract call → passkey prompt → relayer.submit
```

No trustline, no sponsorship sandwich, no device key to store.

### Screening

| Red flag               | A. Server ledger                                                                                      | B. Device outbox                                                                                                | C. Contract account                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Shallow module         | First draft had `prepare`, `submit`, `status`. Revised to one replayable call                         | Server exposes `cosign(envelope)`, a single internal stage. The phone coordinates five steps across the network | Three vendor services, each called in order by the phone |
| Information leakage    | Transaction layout is known to the builder and to the phone's checker. Revised: both live in one file | Layout and fee policy live in the phone's builder and again in the server's validator, in two deploy units      | Contract interface leaks into every caller               |
| Temporal decomposition | First draft split build, sign, submit, poll. Revised to modules by knowledge owned                    | Outbox, submitter and poller are steps, not owners                                                              | Not assessed                                             |
| Pass-through method    | App adapters only move data, but they also bind transport and layers. Accepted                        | `directory.resolve` forwards to a table                                                                         | Not assessed                                             |
| Split ownership        | Each table has one writer                                                                             | Transfer state lives in the phone's outbox and on chain. Any later server-driven flow adds a second writer      | State split between contract, relayer and app            |
| Two ways               | One path for every signed action                                                                      | Payment links and refunds must run on the server, so a second submission path appears                           | Classic accounts are still needed for exchange memos     |
| Importable internals   | Package `exports` hide everything but two entries                                                     | Same mechanism available                                                                                        | Same                                                     |
| Hand-synced list       | The method list is defined once and derived elsewhere                                                 | Sponsor's allowed layouts must mirror the phone's builder by hand                                               | Not assessed                                             |

Outcome:

- **A** survives after two revisions, both applied in the [rest of the sketch](sketch.md).
- **B** is rejected. It cannot finish a payment once the phone is gone, its safety depends on storage the app does not control, and old cached app versions would keep building transactions to old rules.
- **C** is rejected on facts from the official docs. A contract call cannot carry a memo, exchanges do not reliably credit contract transfers, and it needs a relayer service the repo does not have.

Parts of B and C are grafted into A. See `rationale.md`.
