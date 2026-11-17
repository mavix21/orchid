# Sketch: flows and boundaries

Part of the [core wallet flow sketch](sketch.md). Server-side flows, failure handling, boundary rules, and checked API names.

## 8. Flows

### Transfer, server side

```text
transfer(order, approval):
  existing = Transfers.find(order.id)

  existing is Concluded            → its receipt
  existing is Authorized           → reconcile(existing)                       ← this is also "status"
  existing is Proposed, live:
      approval is none             → TransferDraft(existing.request)           ← replay of the first call
      approval is some             → sealed = Chain.seal(request, approval, order.from)
                                       ApprovalInvalid → TransferDraft(existing.request)
                                     Transfers.authorize(id, sealed)
                                       SlotTaken → reconcile(holder); still pending → SenderBusy
                                     Chain.submit(sealed)                      ← errors ignored
                                     → Pending
  existing is none, or Proposed and expired:
      sender    = Directory.byAddress(order.from)        none → NotOpened
      recipient = Directory.byUsername(order.to)         none → UnknownRecipient
      held      = Transfers.latestFrom(order.from)       Authorized → reconcile; still pending → SenderBusy
      available = Chain.balance(order.from)              < amount → InsufficientBalance
      request   = Chain.draftPayment(from, recipient.address, amount)
      Transfers.propose(order, recipient, request)
      → TransferDraft(request, recipient)

reconcile(authorized):
  Chain.settlement(sealed):
    Applied | Rejected | Expired   → Transfers.conclude(id, it) → Settled or Failed
    Undecided                      → Chain.submit(sealed) again → Pending
```

`overview` reconciles the sender's latest transfer the same way before answering. `sweep` reconciles every in-flight transfer.

### What each failure does

| What goes wrong                            | What happens                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Network drops before the first call lands  | Nothing exists. The client retries the same order                                                       |
| The draft response is lost                 | The retry returns the same draft. Still one envelope                                                    |
| App closes before signing                  | An unsigned draft expires. No later code can sign it. Shown as never sent                               |
| The approval request is lost               | Same as above                                                                                           |
| The approval lands, the response is lost   | The transfer is authorized. The retry returns `Pending`                                                 |
| App closes right after approving           | The server holds the sealed envelope. Submit already ran; the sweep repeats it. Home shows it on reopen |
| The submit call fails                      | Ignored. Reconcile submits again while the envelope can still be included                               |
| The transaction is submitted twice         | Same bytes, same sequence number. The network applies it once                                           |
| User taps send twice                       | Two orders. The second gets `SenderBusy` while the first is in flight                                   |
| Database write fails at authorize          | Nothing was submitted. The client retries with the same approval                                        |
| Worker dies between authorize and submit   | Authorized but unsent. Reconcile or sweep submits it, or it expires and fails                           |
| RPC is down for longer than the time bound | Reconcile reports `Undecided` until RPC answers, then reads the ledger clock and decides                |
| A transfer fails and the user sends again  | A new order. Safe, because `Failed` is only ever written with proof                                     |

### Opening, server side

```text
open(claim, approval):
  Directory.available(claim):      // soft check, reserves nothing
    name bound to another address, or reserved → UsernameTaken
    address bound to another name               → AddressBound(profile)
  row = Directory.start(address):
    active                         → Opened(profile)
    opening | recovered (attempt):
      Chain.balance(address) is some → keep status opening; load confirmed sequence
                                     → draft recovery if absent; return RecoveryDraft
                                     → verify approval against stored recovery draft
                                     → bind name if unbound, store signed recovery unsubmitted, activate → Opened
      attempt is Sealed            → Chain.settlement:
                                       Undecided → submit again → OpeningPending
                                       Rejected | Expired → draft again (below)
      attempt is a live draft and approval is some
                                   → Chain.seal → Directory.seal (binds the name in the same write)
                                       UsernameTaken | AddressBound → return it; nothing is submitted
                                       stored → Chain.submit → OpeningPending
      otherwise                    → request = Chain.draftOpening(address); Directory.draft(request)
                                     → OpeningDraft(request)
```

Opening is not exactly-once and does not need to be. Its goal is a state: the account exists, trusts USDC and has a valid signed recovery transaction stored. Creating an account twice is impossible on the ledger, so any number of attempts is safe, and the client simply replays until it reads `Opened`.

The sponsor is the source of every opening transaction, so openings share its sequence number. Two people who sign up in the same few seconds get drafts with the same number; one is applied and the other is drafted again on its next replay. The network also takes only one transaction per source account per ledger. Sign-ups are therefore limited to about one per ledger close. A pool of channel accounts lifts that limit and fits inside `Chain` without changing any signature here.

### Policy constants

They live in `stellar/network.ts` and nowhere else: the testnet passphrase, the USDC code and issuer, and the time bound. A payment draft is valid for 120 seconds. An approval is accepted only while at least 20 seconds remain; otherwise the server drafts again.

## 9. How the boundaries hold

| Rule                                              | What enforces it                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Nothing outside the package imports its internals | The planned `exports` lists two entries. Any other path fails to resolve in `tsc` and in Vite      |
| Tables are written by one module each             | `tables.ts` is not exported, so no other package can reach it. Inside the package it is convention |
| No signature without a check                      | `Keyring` is not exported and has no raw sign method                                               |
| The server signs only what it drafted             | `seal` takes a stored `SigningRequest`; `Approval` has no envelope field                           |
| A final state needs ledger proof                  | `conclude` does not accept `Undecided`; `submit` returns `void`                                    |
| The port's three sides agree                      | One `WalletPort` interface. `Wallet`, `port` and `connectWallet` are all typed by it               |
| Every outcome is handled                          | Outcomes are tagged unions; `Match.valueTags` is exhaustive                                        |
| Server code stays out of the browser              | Not yet enforced. See the open questions                                                           |

## 10. API names and where they were checked

Checked in installed source: `Context.Service`, `Layer.effect`, `Layer.succeed`, `Layer.suspend`, `Layer.provide`, `Effect.fn`, `Effect.die`, `Effect.flatMap`, `Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedError`, `Schema.Union`, `Schema.Literals`, `Schema.Struct`, `Schema.brand`, `Schema.isPattern`, `Schema.isUUID`, `Schema.BigIntFromString`, `Schema.Uint8ArrayFromBase64`, `Schema.DateTimeUtcFromString`, `Schema.OptionFromNullOr`, `Schema.Defect`, `Schema.toStandardSchemaV1`, `Schema.encodeEffect`, `Match.valueTags`, `Redacted.make`, `createServerFn().validator().handler()`, `ssr: false`, `pgTable`, `uniqueIndex().on().where()`, `text({ enum })`, `bigint({ mode })`, `timestamp({ withTimezone })`, `uuid()`.

Not checked: `.check(...)` applied to a schema that is already a transformation (`BigIntFromString`), the exact form of a bigint range filter, and `Layer.provide` taking an array. These are details of bodies, not of the design.
