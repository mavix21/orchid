# Key backup and recovery

This is the design for the passkey backup step. It is not implemented yet: `protect`, `recover` and the enrollment envelope do not exist in `packages/wallet`. It extends the base in [rationale.md](rationale.md). A SEP-0005 phrase is the source of truth, it is never shown at sign-up, and a passkey protects it.

## Summary

- The phone generates 16 random bytes. They are the wallet. Twelve words and the Stellar key are both derived from them.
- A passkey is created at sign-up. Its PRF output derives a key that encrypts the 16 bytes. The ciphertext is stored on the phone and on Orchid's server.
- A new phone recovers with one passkey prompt: the same ceremony proves who the user is to the server and yields the decryption key locally.
- Daily payments do not prompt. They use a non-extractable signing handle.
- If the phone cannot do PRF, sign-up still works with no words shown. The wallet is marked "this phone only" and the app asks the user to save the phrase once money arrives.
- Orchid can never recover a wallet. No passkey and no phrase means the funds are gone.

## Where the secret lives

| Place                       | What is stored                                                                  | Why                                                       |
| --------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Phone, IndexedDB            | Non-extractable signing handle; this passkey's ciphertext.                      | Pay without a prompt. Reveal the phrase offline.          |
| Orchid server, Postgres     | Per passkey: credential id and public key, ciphertext, nonce, version, address. | A synced passkey reaches a new phone; IndexedDB does not. |
| The user's passkey provider | The passkey and its PRF secret (Google Password Manager, Apple Passwords).      | The only cloud the user already has.                      |

The user's own cloud drive stores nothing: a web app cannot write to iCloud, and Drive needs a Google sign-in.

The plain 16 bytes exist in memory at three moments only: creation, recovery and phrase reveal. On a PRF phone they are never written to disk unencrypted.

**What the server can learn:** the username, the address, how many passkeys a wallet has, their public keys, and when a recovery happened. **What it cannot learn:** the phrase or the key. The ciphertext opens only with the PRF output, which needs the authenticator and user verification, and which the phone never sends. `toJSON()` includes PRF results, so the phone builds the server message by hand and leaves them out.

**The limit of that claim.** It holds against a database leak or a curious operator. It does not hold against whoever controls the JavaScript that Orchid serves, because that code sees the bytes at the three moments above. Every web wallet has this limit.

## Key hierarchy

```text
entropy E            16 bytes from crypto.getRandomValues
  ├─ BIP-39          12 English words, no passphrase
  │    └─ BIP-39 seed (PBKDF2-HMAC-SHA512, 2048 rounds)
  │         └─ SLIP-0010 ed25519, path m/44'/148'/0'      SEP-0005 "primary key"
  │              └─ 32-byte Ed25519 seed → G… address
  │                   └─ imported as a non-extractable CryptoKey; raw bytes dropped
  │
  └─ stored only as AES-256-GCM(KEK, E)
       KEK   = HKDF-SHA-256(ikm = PRF output, info = "orchid/seed-wrap/v1")
       PRF output = 32 bytes from prf.eval.first = UTF-8 "orchid/seed-wrap/v1"
       nonce = 12 random bytes per encryption
       AAD   = version ‖ address ‖ credential id
```

- **SEP-0005.** BIP-39 for the phrase, SLIP-0010 for Ed25519, and `m/44'/148'/0'` is the primary key. The SEP's test vectors, including the 12-word one, are the unit tests for this module.
- **12 words, not 24.** SEP-0005 recommends 24. Orchid uses 12 because people copy it by hand, and 128 bits matches Ed25519's security level.
- **Entropy is encrypted, not the words.** It is fixed length and the words are a pure function of it.
- **No per-passkey data key.** Each passkey encrypts `E` directly, one row per passkey.
- **WebCrypto only.** HKDF, PBKDF2 with SHA-512, AES-GCM and the HMAC-SHA-512 that SLIP-0010 needs are all in `SubtleCrypto`. The 2048-word list is loaded lazily.
- **One constant PRF input** for every user and passkey. It lets recovery call `get()` with an empty `allowCredentials`, so the user picks a passkey and never types a username (`evalByCredential` is rejected with an empty list). Each credential already has its own PRF, so a per-user input adds nothing. The input carries a version; a new scheme uses a new string and re-encrypts at the next prompt.
- **User verification is required** on `create()` and `get()`. CTAP `hmac-secret` has separate seeds with and without it.

## Sign-up

The user sees: type a username, tap Create, one system passkey sheet, home screen. No words.

```text
create(username):
  1. E = random; derive address; import signing handle; keep E in memory
  2. port.open(claim, none)        → checks the username (reserves nothing), returns the opening draft;
                                     a taken name stops here, before any passkey exists
  3. navigator.credentials.create  rp.id = Orchid's domain, user.name = username,
                                     user.id = 32 random bytes, residentKey "required",
                                     userVerification "required", prf.eval.first = constant
       prf.results.first present   → use it
       prf.results.first absent    → navigator.credentials.get with the same input (second sheet)
       no PRF output from get()    → device-only wallet (see "When PRF is not available")
  4. wrap E; store the wrap in IndexedDB; drop E from memory
  5. approve the opening draft; port.open(claim, approval) → binds the name; replay until Opened;
                                     a name lost to a concurrent signer returns UsernameTaken here
  6. port.protect(enrollment, …)   → upload the wrap; replayed on next launch if it fails
```

- **One sheet or two.** Not every authenticator evaluates the PRF at creation; then an assertion is needed. Worst case is two sheets back to back.
- **Username first.** A taken name never leaves an orphan passkey in the user's password manager. Only a race lost at step 5 can still leave one.
- **`user.id` is random.** WebAuthn forbids personal data in the user handle.
- **Crash safety.** The signing handle is saved in step 1 and the wrap in step 4, so every later step is a replay. If the app dies between 1 and 4, nothing was signed or reserved, and the name stays free.

## Recovery on a new phone

The user sees: "I already have a wallet", one passkey sheet, home screen.

```text
restore():
  1. port.recover(none)            → a fresh challenge
  2. navigator.credentials.get     challenge, rp.id, empty allowCredentials,
                                     userVerification "required", prf.eval.first = constant
  3. port.recover(assertion)       → server verifies the signature with the stored public key,
                                     finds the row by credential id,
                                     returns profile + ciphertext + nonce
  4. KEK from the PRF output; decrypt; derive the address; it must equal profile.address
  5. import the signing handle; store the wrap locally; drop E
```

The passkey assertion is the authentication. One ceremony gives a signature the server checks and a PRF output the server never sees. The server keeps each credential's public key from enrollment (`getPublicKey()` returns DER SubjectPublicKeyInfo). Step 4 means the server cannot substitute another wallet's ciphertext: GCM rejects it, and the address comparison catches anything else. This is the first authenticated call in the system and the natural base for sessions later.

## Showing the phrase

Settings → Security → Recovery phrase.

1. A warning in plain words: these 12 words are the wallet; anyone who has them can take the money; Orchid will never ask for them and cannot replace them.
2. Continue triggers a fresh passkey `get()` with the PRF input. The decryption is the re-authentication: the words do not exist until the passkey answers.
3. The words appear hidden and show on tap. A copy button exists, with a second warning.
4. Leaving the screen clears the bytes from memory. The app records locally that the phrase was seen.

A device-only wallet has no passkey to ask, so step 2 is skipped; anyone holding the unlocked phone can reveal. That is accepted for testnet.

The phrase imports into any SEP-0005 wallet as account 0. Showing it changes nothing on the ledger; the same key now exists in two apps. The reserve sponsor keeps carrying 1.5 XLM per wallet, and the account holds 0 XLM, so another wallet cannot pay a fee until the user sends it XLM. Orchid does not reclaim the reserve. If another wallet advances the sequence, a signed Orchid transfer never applies and is recorded `Failed` once its time bound passes. If another wallet removes the trustline or merges the account, `overview` returns `NeedsReopening` and `open` repairs it under the same username and key.

## When PRF is not available

Three cases, detected in this order:

1. `PublicKeyCredential.getClientCapabilities()` reports no platform authenticator, or the browser has no WebAuthn. No passkey is attempted.
2. `create()` returns no PRF output and a following `get()` also returns none.
3. The user cancels the passkey sheet twice.

In all three the wallet is still created as a **device-only wallet**:

- `E` is encrypted with a non-extractable AES-GCM `CryptoKey` kept in IndexedDB. This stops casual export through the page; it is not hardware protection.
- Nothing is sent to the server.
- The app calls `navigator.storage.persist()`.

| Moment                       | Screen                                                                |
| ---------------------------- | --------------------------------------------------------------------- |
| Sign-up                      | Nothing extra. Same flow, minus the passkey sheet.                    |
| Home, balance 0              | A small "Not backed up" mark.                                         |
| First funds arrive           | One sheet: "Your money lives only on this phone. Save your phrase."   |
| Balance passes 20 USDC       | A home banner until the phrase or a passkey backup is saved.          |
| Later, PRF becomes available | "Turn on passkey backup" runs sign-up steps 3, 4 and 6. Same address. |

"Save now" is the reveal flow followed by a check that asks for three of the words. Passing it clears the banner; the flag is local to the phone.

The real danger in this mode is storage loss, not theft. Safari deletes script-writable storage after seven days without a visit unless the app is added to the home screen, so the install prompt matters most for these users.

**Rejected fallbacks.** A password or PIN encrypting a server-side blob, because a short secret can be brute-forced offline by anyone holding the blob. Enclave or social-login recovery, because it makes Orchid a recovery party. Refusing sign-up without PRF, because it excludes the cheap phones Orchid is for.

### PRF implementation rules

- Request `prf.eval` at `create()`. If `results.first` is missing, call `get()` with the same input before concluding PRF is unavailable.
- Request `residentKey: "required"` so Android routes to Google Password Manager instead of the security-key chooser.
- Do not rely on `getClientCapabilities()['extension:prf']` alone: it signals that the browser forwards the extension, not that the provider returns a result.
- Android WebView does not support PRF; Chrome on Android does.
- Do not use cross-device (hybrid) recovery on iOS before 18.4, which returned a different PRF output.
- `http://localhost` passkeys are scoped to localhost. The demo uses a disposable `workers.dev` host.

## More passkeys, and none

**Same ecosystem.** Nothing to do. The passkey syncs and recovery works.

**The other ecosystem (Android to iPhone or back).** Passkeys do not sync across. Either use "use a passkey from another device" (QR) on the new phone, then add a local passkey, or type the recovery phrase, then add a passkey.

**Adding a passkey** (also the upgrade from device-only):

```text
protect():
  1. get E by an existing passkey prompt or the device key
  2. create the new passkey; get its PRF output; wrap E
  3. port.protect(enrollment, none)                → a draft the server built
  4. approve it; port.protect(enrollment, approval) → Protected
```

A write must be authorized, and the only credential every writer has is the Stellar key, which has no raw sign method. So the server drafts a third envelope layout in the style of SEP-0010: a transaction with sequence number 0, which cannot execute on the network, carrying one `manage_data` operation whose value is the SHA-256 of the enrollment (credential id, public key, ciphertext, nonce). The phone checks the layout with `readEnvelope`, as for payments, and returns only a signature. Rows are insert-only on testnet.

**Removing a passkey** is deferred. Deleting the server row does not stop someone who already copied the ciphertext and holds the passkey; real revocation means moving the funds to a new seed.

| The user still has     | Outcome                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| The phone with the app | Payments work; no reveal and no new backup. Move funds to a new wallet.             |
| The written phrase     | "Use a recovery phrase": derive the address, find the username, add a passkey.      |
| Neither                | The funds are lost. Orchid cannot help. The reserve sponsor's 1.5 XLM stays locked. |

## Fit with `packages/wallet`

The UI call does not change: `wallet.create("maria")`; the passkey sheet happens inside it.

- **Device.** `Keyring` stays the only code that signs, still with no raw sign method. It gains the phrase, the derivation, the wraps, and `protect`, `restore`, `restoreFromPhrase` and `reveal`. A separate internal module owns the WebAuthn calls and knows nothing about Stellar. `WalletClient` gains `restore()`, `restoreFromPhrase(text)`, `revealPhrase()` and `protect()`. `Holding` gains a local backup state: `passkey`, `phrase` or `none`. A missing PRF is not `UnsupportedDevice`.
- **Server.** `WalletPort` gains replayable `protect(enrollment, approval)` and `recover(assertion)`. A new internal `Passkeys` service is the only writer of a `passkeys` table and the only code that verifies WebAuthn assertions, on Workers WebCrypto. `stellar/envelopes.ts` gains the enrollment layout and its reader, covered by the same round-trip test. `open` and `transfer` do not change.

## Threats and tradeoffs

| Threat                                      | Answer                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Orchid's database leaks                     | Ciphertexts are useless without a PRF output. 256-bit keys, no user-chosen secret anywhere.            |
| Orchid serves malicious code, or XSS        | Not solvable in a web app. Strict CSP, no third-party scripts, no remote content on the reveal screen. |
| The user's Google or Apple account is taken | The wallet is as safe as that account. The reveal warning says so.                                     |
| The provider loses a passkey                | The phrase, if saved. An optional reminder for passkey users too.                                      |
| Phone stolen, unlocked                      | Payments possible; reveal needs the passkey. No payment prompt on testnet.                             |
| Phishing for the phrase                     | Passkeys are bound to the domain; phrases are not. The reveal copy says Orchid never asks for it.      |
| Orchid's domain changes                     | Every passkey stops working. Demo wallets are disposable until the real domain exists.                 |
| Browser storage evicted                     | PRF wallet: restore by passkey. Device-only wallet: total loss, hence `persist()` and the nudges.      |
| Testnet reset                               | Accounts vanish, seeds do not. The same address opens again from the same seed.                        |

Tradeoffs accepted: the key is derivable from stored data, in exchange for export and recovery; one authenticated call and one table, in exchange for recovery with no password or username; up to two sheets at sign-up on some phones, in exchange for a backup from the first second; device-only wallets for some users, in exchange for not turning away cheap phones; security resting on the user's Google or Apple account, in exchange for nothing to remember.

**Rejected: deriving the seed from the PRF output directly.** A second passkey would produce a different wallet, and the device-only path could not upgrade to it.

## Decisions

- **Phrase length.** 12 words.
- **Passkey prompt on payments.** None on testnet. On mainnet, a prompt above an amount that is not yet defined.
- **Phones without PRF.** Allowed, as device-only wallets with the nudges above.
- **Recovery authentication.** The server verifies the passkey assertion before it returns a ciphertext.
- **Banner threshold.** 20 USDC.
- **Device-key copy of the seed on PRF phones.** No. The gap for a user who loses every passkey but keeps the phone is accepted.
- **Passkey RP ID.** No domain has been bought. The demo uses a `workers.dev` host and its full host as RP ID, never `<account>.workers.dev`. Demo wallets are disposable: a domain change breaks passkey restore. Buy the real domain before creating non-disposable passkeys.
- **PRF device test.** Run it on cheap Android phones on the final domain before implementation.

## Sources

- [WebAuthn Level 3, PRF extension](https://www.w3.org/TR/webauthn-3/#prf-extension)
- [MDN, WebAuthn extensions](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions)
- [MDN, `getClientCapabilities()`](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/getClientCapabilities_static)
- [MDN, `getPublicKey()`](https://developer.mozilla.org/en-US/docs/Web/API/AuthenticatorAttestationResponse/getPublicKey)
- [MDN, `StorageManager.persist()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
- [WebKit, seven-day storage cap](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
- [passkeys.dev, device support](https://passkeys.dev/device-support/)
- [SEP-0005](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md), [SEP-0010](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md), [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki), [SLIP-0010](https://github.com/satoshilabs/slips/blob/master/slip-0010.md)
- [Stellar, sponsored reserves](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves)
