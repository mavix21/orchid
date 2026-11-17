# Key backup: passkeys and the wallet package

Part of [Key backup and recovery](backup.md), which also defines the **[spec]**, **[docs]** and **[unverified]** tags and lists the sources. Adding and losing passkeys, and how this step fits `packages/wallet`.

## 8. More passkeys, and none

**Same ecosystem.** Nothing to do. The passkey syncs and [section 5](backup-flows.md#5-recovery-on-a-new-phone) works.

**A phone from the other ecosystem (Android to iPhone or back).** Passkeys do not sync across. Two ways in:

1. On the new phone choose "I already have a wallet". The system sheet offers "use a passkey from another device" and shows a QR code for the old phone. PRF support depends on the provider and OS; avoid hybrid recovery on iOS before 18.4 ([section 6](backup-prf.md#6-when-prf-is-not-available)). If it works, the wallet restores, and the app then offers "Add a passkey on this phone".
2. Type the recovery phrase. Then add a passkey.

**Adding a passkey** (also the upgrade from device-only):

```text
protect():
  1. the phone holds the signing handle; get E by an existing passkey prompt or the device key
  2. create the new passkey; get its PRF output; wrap E
  3. port.protect(enrollment, none)       → a draft the server built
  4. approve it; port.protect(enrollment, approval) → Protected
```

A write must be authorised, and the only credential every writer has is the Stellar key. The base design forbids a raw `sign(bytes)`. So the server drafts a third envelope layout, in the style of SEP-0010: a transaction with sequence number 0, which "cannot be executed on the Stellar network", carrying one `manage_data` operation [spec]. The data value is the SHA-256 of the enrolment (credential id, public key, ciphertext, nonce). The phone checks the layout with `readEnvelope`, as it does for payments, and returns only a signature. Rows are insert-only on testnet.

**Removing a passkey** is deferred. Deleting the server row does not stop someone who already copied the ciphertext and holds the passkey. Real revocation means moving the funds to a new seed.

**Losing every passkey.**

| The user still has     | Outcome                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The phone with the app | Payments keep working. The phrase cannot be revealed. Add a new passkey at once; `E` is gone from this phone, so see below.  |
| The written phrase     | Welcome → "Use a recovery phrase". The address is derived, `overview(address)` returns the username, a new passkey is added. |
| Neither                | The funds are lost. Orchid cannot help. The reserve sponsor's 1.5 XLM stays locked.                                          |

The first row has a gap: with the passkey deleted, the phone has a signing handle but no way to get `E` back, so no new backup can be made. The only safe exit is to send the balance to a fresh wallet. A PRF phone could close the gap by also keeping `E` under the local device key from [section 6](backup-prf.md#6-when-prf-is-not-available), at the cost of some at-rest protection. Decision D6 rejects that, so the gap is accepted.

## 9. Fit with `packages/wallet`

The UI call does not change: `wallet.create("maria")`. The passkey sheet happens inside it.

**Device side.**

- `Keyring` keeps its role: it holds the key and is the only code that signs. Its secret grows to include the phrase, the derivation and the wraps.
  - `enroll` now makes `E` and derives the key, where it used to generate a key directly.
  - It gains `protect`, `restore`, `restoreFromPhrase` and `reveal`. It still has no raw sign method.
- A new internal module owns the WebAuthn calls and the PRF. It knows nothing about Stellar.
- `WalletClient` gains four calls, each returning a tagged outcome like the existing three:
  - `restore()`
  - `restoreFromPhrase(text)`
  - `revealPhrase()`
  - `protect()`
- `Holding` gains a local field for the backup state: `passkey`, `phrase` or `none`. The server does not supply it.
- `UnsupportedDevice` keeps its meaning: no native Ed25519. A missing PRF is not that outcome.

**Server side.**

- `WalletPort` gains two replayable calls, in the existing draft-then-approve rhythm:
  - `protect(enrollment, approval)`
  - `recover(assertion)`
- A new internal service, `Passkeys`, is the only writer of a new `passkeys` table and the only code that verifies WebAuthn assertions.
- Verification runs on Workers WebCrypto. Passkeys commonly sign with ES256. I did not confirm ECDSA P-256 verify cost on the free plan [unverified]; add it to the CPU measurement already planned.
- `stellar/envelopes.ts` gains the enrolment layout and its reader, covered by the same round-trip test.
- `open` and `transfer` do not change.

**Package entries.** The planned root and `./server` entries are described in `rationale.md`; browser code sits beside `Keyring`.

### Changes to `rationale.md`

1. "The phone stores only its key" becomes: the phone stores a signing handle and an encrypted copy of its seed; the server stores an encrypted copy per passkey.
2. Remove "key backup" from "Deliberately not done". Sessions stay there.
3. Replace the pending "Key backup" decision with a pointer to this document.
4. "Browser minimum" stands. Passkey backup has its own, higher floor, and phones below it get the device-only path.
5. Add one tradeoff: we accept that the seed is in page memory at creation, recovery and reveal in exchange for a phrase the user can take elsewhere.
6. Add the departed-account case from [section 7](backup-flows.md#7-showing-the-phrase-export) to the open questions.

The six load-bearing decisions and the synthesis are untouched.
