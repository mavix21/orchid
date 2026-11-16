# Key backup and recovery

Design only, no code. It extends the approved base in `rationale.md` and settles its "Key backup" decision. The owner's decisions are in section 12. Option 3 is given: a SEP-0005 phrase is the source of truth, it is never shown at sign-up, and a passkey protects it.

Each claim is marked by how it was checked: **[spec]** read in the W3C or Stellar text, **[docs]** read in vendor documentation, **[unverified]** not confirmed from an official source. Section 11 collects the unverified ones.

## 1. Summary

- The phone generates 16 random bytes. They are the wallet. Twelve words and the Stellar key are both derived from them.
- A passkey is created at sign-up. Its PRF output derives a key that encrypts the 16 bytes. The ciphertext is stored on the phone and on Orchid's server.
- A new phone recovers with one passkey prompt: the same ceremony proves who the user is to the server and yields the decryption key locally.
- Daily payments do not prompt. They use a non-extractable signing handle, as the base design already planned.
- If the phone cannot do PRF, sign-up still works with no words shown. The wallet is marked "this phone only" and the app asks the user to save the phrase once money arrives.
- Orchid can never recover a wallet. No passkey and no phrase means the funds are gone.

## 2. Where the secret lives

| Place                                      | What is stored                                                                                              | Why                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Phone, IndexedDB                           | The non-extractable Ed25519 signing handle. A copy of the ciphertext for this passkey.                      | Pay without a prompt. Reveal the phrase offline.                                                                   |
| Orchid server, Postgres                    | One row per passkey: credential id, credential public key, ciphertext, nonce, version, wallet address.      | A synced passkey arrives on a new phone, but IndexedDB does not. Something must hand the ciphertext to that phone. |
| The user's passkey provider                | The passkey, and with it the PRF secret. Google Password Manager on Android, Apple Passwords on iOS [docs]. | It is the only cloud the user already has and never had to set up.                                                 |
| The user's own cloud drive (Drive, iCloud) | Nothing.                                                                                                    | A web app cannot write to iCloud, and Drive needs a Google sign-in. Both add a step to sign-up.                    |

The plain 16 bytes exist in memory at three moments only: creation, recovery, and phrase reveal. On a PRF phone they are never written to disk unencrypted.

**What the server can learn.** The username, the address, how many passkeys a wallet has, their public keys, and when a recovery happened. It already knows the first two.

**What the server cannot learn.** The phrase or the key. The ciphertext opens only with the PRF output, which needs the authenticator and user verification, and which the phone never sends. The spec warns that `toJSON()` includes PRF results [spec], so the phone must build the server message by hand and leave them out.

**The limit of that claim.** It holds against a database leak or a curious operator. It does not hold against whoever controls the JavaScript that Orchid serves, because that code sees the bytes at the three moments above. Every web wallet has this limit.

## 3. Key hierarchy

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

Notes on each step:

- **SEP-0005.** BIP-39 for the phrase, SLIP-0010 for Ed25519, path `m/44'/148'/x'`, and `m/44'/148'/0'` is the primary key [spec]. The SEP has five test vectors, including a 12-word one [spec]. They become the unit tests for this module.
- **12 words, not 24.** SEP-0005 says "We strongly recommend using 24 word mnemonic" [spec]. Family uses 12 [docs]. Orchid uses 12: it is the phrase people will copy by hand and type back, and 128 bits matches the security level of Ed25519. This deviates from a recommendation and was decided as D1.
- **Entropy is encrypted, not the words.** It is fixed length and the words are a pure function of it.
- **PRF output.** The spec defines PRF outputs as 32 bytes and gives encryption keys as the motivating example [spec]. The client hashes the input as `SHA-256("WebAuthn PRF" ‖ 0x00 ‖ input)` before the authenticator sees it [spec], so the input needs no secrecy.
- **No per-passkey data key.** Each passkey encrypts `E` directly, one row per passkey. An intermediate key would only help if the payload were large or rotated.
- **WebCrypto.** HKDF, PBKDF2 with SHA-512, and AES-GCM are all in `SubtleCrypto` [docs]. SLIP-0010 needs only HMAC-SHA-512. The only asset to ship is the 2048-word list, loaded lazily. Whether to use a library for BIP-39 is an implementation choice.
- **Importing the derived key.** MDN's `importKey` page does not list which format takes an Ed25519 private key [unverified]. `ground.md` records that `effect/crypto` wraps a non-extractable `CryptoKey`. The first implementation step must show that a derived key can be imported with `extractable: false`.

### PRF input ("salt") handling

One constant input for every user and every passkey. The reasons:

- With a constant, recovery can call `get()` with an empty `allowCredentials` and `prf.eval`. The user picks their passkey and never types a username. Per-passkey inputs need `evalByCredential`, which the spec rejects when `allowCredentials` is empty [spec]. That would force a username field and an unauthenticated lookup of credential ids before the prompt.
- Uniqueness comes from the passkey: each credential has its own PRF [spec]. A per-user input adds nothing.
- The input carries a version. A future scheme uses a new string and re-encrypts at the next prompt. The spec's second input (`eval.second`) exists for that kind of rotation [spec]. It is not used now.

The PRF needs user verification. On authenticators built on CTAP `hmac-secret`, the spec says the PRF "MUST be the one used for when user verification is performed" and that this overrides the request's setting [spec]. Orchid asks for `userVerification: "required"` anyway.

## 4. Sign-up

The user sees: type a username, tap Create, one system passkey sheet, home screen. No words.

```text
create(username):
  1. E = random; derive address; import signing handle; keep E in memory
  2. port.open(claim, none)            → reserves the username, returns the opening draft
                                         (UsernameTaken stops here, before any passkey exists)
  3. navigator.credentials.create      rp.id = Orchid's domain, user.name = username,
                                         user.id = 32 random bytes, residentKey "required",
                                         userVerification "required", prf.eval.first = constant
       prf.results.first present       → use it
       prf.results.first absent        → navigator.credentials.get with the same input (second sheet)
       no PRF output from get()        → section 6, the fallback
  4. wrap E; store the wrap in IndexedDB; drop E from memory
  5. approve the opening draft; port.open(claim, approval) → replay until Opened
  6. port.protect(enrollment, …)       → upload the wrap (section 8). Replayed on next launch if it fails
```

- **One sheet or two.** The spec says not all authenticators evaluate the PRF at creation, and then "an assertion is needed in order to obtain the outputs" [spec]. MDN repeats it [docs]. Provider results vary: see the Android implementation rules below. Worst case is two sheets back to back.
- **Username first.** Step 2 runs before step 3 so a taken name never leaves an orphan passkey in the user's password manager.
- **`user.id` is random.** The spec forbids personal data in the user handle [spec].
- **Crash safety.** The signing handle is saved in step 1 and the wrap in step 4, so every later step is a replay. If the app dies between 1 and 4, `E` is lost while the username is only claimed, not active. The stale-claim takeover in `Directory.claim` already covers that.

## 5. Recovery on a new phone

The user sees: "I already have a wallet", one passkey sheet, home screen.

```text
restore():
  1. port.recover(none)                → a fresh challenge
  2. navigator.credentials.get         challenge, rp.id, empty allowCredentials,
                                         userVerification "required", prf.eval.first = constant
  3. port.recover(assertion)           → server verifies the signature with the stored public key,
                                         finds the row by credential id,
                                         returns profile + ciphertext + nonce
  4. KEK from the PRF output; decrypt; derive the address; it must equal profile.address
  5. import the signing handle; store the wrap locally; drop E
```

**How the fetch is authenticated without a password.** The passkey assertion is the authentication. One ceremony gives two results: a signature the server checks, and a PRF output the server never sees. The server keeps each credential's public key from enrolment. `AuthenticatorAttestationResponse.getPublicKey()` returns it as DER SubjectPublicKeyInfo [docs].

The check in step 4 means the server cannot substitute another wallet's ciphertext. GCM rejects it, and the address comparison catches anything else.

This is the first authenticated call in the system. It is also the natural base for sessions later. Sessions stay out of scope.

**Simpler variant, not chosen.** Skip server verification and serve the row to anyone who presents a credential id. The id is random and known only to the authenticator, the provider and Orchid, and the ciphertext is useless without the PRF. It saves one server module. It was not chosen because adding and removing passkeys need real authentication anyway, and a wrong passkey row would later become a sign-in bypass. Decided as D4.

## 6. When PRF is not available

Three cases, detected in this order:

1. `PublicKeyCredential.getClientCapabilities()` reports no platform authenticator, or the browser has no WebAuthn. No passkey is attempted.
2. `create()` returns no PRF output and a subsequent `get()` also returns none. The passkey exists but cannot protect the backup.
3. The user cancels the passkey sheet twice.

In all three the wallet is still created. The result is a **device-only wallet**:

- `E` is encrypted with a non-extractable AES-GCM `CryptoKey` kept in IndexedDB. This stops casual export through the page. It is not hardware protection. It is the same trust level as the signing handle in the approved design.
- Nothing is sent to the server. There is no blob that a weak secret could protect.
- The app calls `navigator.storage.persist()`. Chrome and Safari decide silently from the user's history with the site [docs].

What the user sees, in order:

| Moment                          | Screen                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sign-up                         | Nothing extra. Same flow, minus the passkey sheet.                                                                        |
| Home, balance 0                 | A small "Not backed up" mark on the profile. No interruption.                                                             |
| First funds arrive              | One sheet: "Your money lives only on this phone. Save your recovery phrase." Two buttons: Save now, Later.                |
| Balance passes a threshold (D5) | A banner on home that stays until the phrase is saved or a passkey backup is turned on.                                   |
| Later, PRF becomes available    | Settings and the banner offer "Turn on passkey backup". It runs steps 3, 4 and 6 of sign-up. No new wallet, same address. |

"Save now" is the reveal flow in section 7, followed by a check that asks for three of the words. Passing it clears the banner. The flag is local to the phone.

This keeps the rule: no words at sign-up, and words appear only when there is something to lose.

**The real danger in this mode** is storage loss, not theft. Safari deletes script-writable storage, IndexedDB included, after seven days of browser use without a visit to the site; apps added to the home screen are exempt [docs, a 2020 WebKit post]. A device-only wallet in a Safari tab can vanish. On iOS this mode only arises below Safari 18, since Safari 18.0 added PRF [docs]. The install prompt matters most for these users.

**Rejected fallbacks.**

- A password or PIN that encrypts a server-side blob. A short secret can be brute-forced offline by anyone holding the blob, the server included.
- Enclave or social-login recovery in the style of Cavos. It needs infrastructure the repo does not have and makes Orchid a recovery party.
- Refusing sign-up without PRF. It is the safest and it excludes exactly the cheap phones Orchid is for. Rejected by decision D3.

### PRF support: what is known

| Source                              | What it says                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebAuthn Level 3                    | A W3C Recommendation since 2026-08-25. PRF is section 10.1.4 [spec].                                                                                            |
| WebKit                              | "WebKit for Safari 18.0 adds support for the WebAuthn prf extension" [docs].                                                                                    |
| MDN compat data, `create()` + `prf` | Chrome 116, Chrome Android and Edge mirror it, Firefox 139 (135 to 138 partial, not on macOS), Firefox Android 149, Safari 18, Android WebView no [docs].       |
| MDN compat data, `get()` + `prf`    | Chrome 116 and Firefox 139 [docs]. Its Firefox Android "no" row is stale; Mozilla fixed Android support in Firefox 149. Its Safari "no" row contradicts WebKit. |
| MDN compat data, capabilities       | `getClientCapabilities()`: Chrome 133, Firefox 135, Safari 17.4 [docs].                                                                                         |
| passkeys.dev                        | No PRF row in the device matrix. Android 9+ creates passkeys backed up to Google Password Manager [docs].                                                       |

A browser version is not enough. PRF also depends on the passkey provider and the OS, and no official matrix covers that. See section 11.

### PRF on Android: implementation rules

Chrome supports `prf` for `create()` and `get()` on Android since Chrome 116 (August 2023); Android WebView does not. Samsung Internet and Edge mirror Chrome. Firefox Android supports PRF since 149; MDN's Firefox Android `get()` row is stale. See [Chromium](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI), [MDN compat data](https://github.com/mdn/browser-compat-data/blob/main/api/CredentialsContainer.json), and [Mozilla](https://bugzilla.mozilla.org/show_bug.cgi?id=1958716).

Google's Adam Langley says Google Password Manager passkeys return PRF ([WebAuthn issue](https://github.com/w3c/webauthn/issues/1830#issuecomment-1774092530), [Chromium discussion](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI)). Independent [Corbado tests](https://www.corbado.com/blog/passkeys-prf-webauthn) in 2026 report Google Password Manager success of 91–100% at `create()` and 100% at `get()`. They also report Samsung Pass often returns no value at `create()` but does at `get()`, Bitwarden is unreliable on Android, and Dashlane returns none. These provider results are independent tests, not official guarantees.

- Request `prf.eval` at `create()`. If `results.first` is missing, call `get()` with the same input before concluding PRF is unavailable; only then show a second sheet.
- Request a discoverable credential with `residentKey: "required"` so Android routes to Google Password Manager instead of the security-key chooser.
- Do not rely on `getClientCapabilities()['extension:prf']` alone (Chrome 133+): it signals browser support for forwarding the extension, not a PRF result from the provider. See [MDN](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/getClientCapabilities_static).

## 7. Showing the phrase (export)

Settings → Security → Recovery phrase.

1. A warning screen in plain words: these 12 words are the wallet; anyone who has them can take the money; Orchid will never ask for them; Orchid cannot replace them.
2. Continue triggers a fresh passkey `get()` with the PRF input. The decryption is the re-authentication: the words do not exist until the passkey answers, so no UI trick can skip it.
3. The words appear hidden and show on tap. A copy button exists, with a second warning. Family's flow is the same shape: warning, Reveal, copy or write down [docs].
4. Leaving the screen clears the bytes from memory. The app records locally that the phrase was seen.

A device-only wallet has no passkey to ask, so step 2 is skipped. Anyone holding the unlocked phone can reveal. That is accepted for testnet.

The phrase imports into any SEP-0005 wallet as account 0. I did not confirm that Freighter and Lobstr accept 12 words [unverified].

### What happens to the sponsored reserves

Showing the phrase changes nothing on the ledger. There is no "leave" event: the same key now exists in two apps.

- The reserve sponsor keeps carrying 1.5 XLM per wallet: two base reserves for the account plus one for the trustline, at 0.5 XLM each [docs].
- The account holds 0 XLM. In another wallet the user cannot pay a fee until they send XLM to it. Inside Orchid the fee payer still pays by fee bump.
- If the user removes the trustline, the reserve sponsor's count drops and that reserve is free again [docs].
- If the user merges the account away, they must remove the trustline first; being sponsored does not block a merge [docs]. The docs page does not state where the account's own reserve goes on merge [unverified]. The expectation is that it returns to the reserve sponsor.
- The reserve sponsor can revoke a sponsorship without the user's signature [docs]. With 0 XLM the account cannot take the reserve over, so the revoke should fail. The error is not documented on the page read [unverified].

Recommendation: do nothing. 1.5 XLM is the acquisition cost already spent at sign-up, and reclaiming it would break the user's account.

Effects on the approved transfer design, all already handled or small:

- Another wallet can advance the account's sequence number. A signed Orchid transfer then never applies, its time bound passes, and it is recorded `Failed` with proof. No rule changes.
- Another wallet can remove the trustline or merge the account. `Chain.balance` then returns none for an `active` wallet. `overview` needs an answer for that. This is a new small case for the base design.

## 8. More passkeys, and none

**Same ecosystem.** Nothing to do. The passkey syncs and section 5 works.

**A phone from the other ecosystem (Android to iPhone or back).** Passkeys do not sync across. Two ways in:

1. On the new phone choose "I already have a wallet". The system sheet offers "use a passkey from another device" and shows a QR code for the old phone. Whether PRF outputs travel over this cross-device path is [unverified]. If it works, the wallet restores, and the app then offers "Add a passkey on this phone".
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

The first row has a gap: with the passkey deleted, the phone has a signing handle but no way to get `E` back, so no new backup can be made. The only safe exit is to send the balance to a fresh wallet. A PRF phone could close the gap by also keeping `E` under the local device key from section 6, at the cost of some at-rest protection. Decision D6 rejects that, so the gap is accepted.

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

**Package entries.** `rationale.md` names two entries (`.` and `./server`); `sketch.md` section 2 lists a third, `./device`. This design does not depend on which is right. All new browser code sits beside `Keyring`.

### Changes to `rationale.md`

1. "The phone stores only its key" becomes: the phone stores a signing handle and an encrypted copy of its seed; the server stores an encrypted copy per passkey.
2. Remove "key backup" from "Deliberately not done". Sessions stay there.
3. Replace the pending "Key backup" decision with a pointer to this document.
4. "Browser minimum" stands. Passkey backup has its own, higher floor, and phones below it get the device-only path.
5. Add one tradeoff: we accept that the seed is in page memory at creation, recovery and reveal in exchange for a phrase the user can take elsewhere.
6. Add the departed-account case from section 7 to the open questions.

The six load-bearing decisions and the synthesis are untouched.

## 10. Threats and tradeoffs

| Threat                                          | Effect                                                                | Answer                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Orchid's database leaks                         | Ciphertexts and public keys are exposed.                              | Useless without a PRF output. 256-bit keys, no user-chosen secret anywhere.                                            |
| Orchid serves malicious code                    | Total loss for users who open the app.                                | Not solvable in a web app. Strict CSP, no third-party scripts, reviewed deploys.                                       |
| XSS                                             | Can drive payments today. New: can steal the seed during a reveal.    | Same CSP. The reveal screen renders no remote content. The seed is never in memory outside the three moments.          |
| The user's Google or Apple account is taken     | The attacker gets the passkey, passes recovery and decrypts.          | The wallet is as safe as that account. This is the price of no-password recovery. State it in the reveal warning copy. |
| The passkey provider loses or deletes a passkey | Recovery by passkey is gone.                                          | The phrase, if saved. A gentle, optional reminder for passkey users too.                                               |
| Phone stolen, unlocked                          | Payments possible, as in the base design. Reveal needs the passkey.   | A payment prompt would close it. Decision D2: none on testnet.                                                         |
| Phishing for the phrase                         | Total loss.                                                           | Passkeys are bound to the domain; phrases are not. Reveal copy says Orchid never asks for it.                          |
| Orchid's domain changes                         | Every passkey stops working, because a passkey is bound to its RP id. | Fix the domain before any passkey is created. Decision D7.                                                             |
| Browser storage evicted                         | PRF wallet: none, restore by passkey. Device-only wallet: total loss. | `persist()`, the install prompt, the funds-arrive nudge.                                                               |
| Testnet reset                                   | Accounts vanish, seeds do not.                                        | The same address can be opened again from the same seed.                                                               |

Tradeoffs accepted:

- We accept that the key is derivable from stored data, where the base design had a key no code could ever read, in exchange for export and recovery.
- We accept one authenticated server call and one new table in exchange for recovery with no password and no username typed.
- We accept up to two system sheets at sign-up on some phones in exchange for a backup that exists from the first second.
- We accept that some users will run device-only in exchange for not turning away cheap phones.
- We accept that security rests on the user's Google or Apple account in exchange for a sign-up with nothing to remember.

**Alternative considered: derive the seed from the PRF output directly.** No ciphertext, no server table, no recover call. It lost because a second passkey would produce a different wallet, the device-only path could not upgrade to it, and it stops being "a phrase encrypted by a passkey", which is the approved option.

## 11. Not verified

1. Google Password Manager PRF on low-end Android (Android 9 to 12, Go edition, old Play Services): no official device matrix was found.
2. Whether a synced passkey gives the same PRF output on every device. The spec ties one PRF to a credential for its lifetime, and design and tests imply the same output, but no verbatim Google statement was found [unverified].
3. PRF over the cross-device (QR) path, in either direction between Android and iOS.
4. Provider behaviour on target phones, including Samsung Pass, third-party providers, and Windows Hello. Corbado's results above are not an official guarantee.
5. The MDN Safari `get()` PRF row contradicts WebKit.
6. Import of a derived Ed25519 key as non-extractable on the target Android browsers. `ground.md` already lists the storage half as untested.
7. ECDSA P-256 verification CPU on the Workers free plan, and whether a maintained WebAuthn server library runs there.
8. Whether Safari's seven-day storage rule from 2020 is unchanged.
9. Freighter and Lobstr importing a 12-word phrase, and how they show a sponsored account with 0 XLM.
10. Where the account's own reserve goes on merge, and the exact revoke failure.
11. Family: the page read does not say a passkey prompt precedes the reveal, and does not mention iCloud. Cavos: its page does not mention PRF, Google, Apple or email. Both differ from the research summary in the brief.

Items 1 to 4 need a test page and a handful of real phones. That test should run before any of this is built.

## 12. Decisions

Accepted by the owner on 2026-11-15.

- **D1. Phrase length.** 12 words. SEP-0005 strongly recommends 24; the deviation is accepted.
- **D2. Passkey prompt on payments.** None on testnet. On mainnet, a prompt above an amount. The amount is not defined yet.
- **D3. Phones without PRF.** Allowed. They get a device-only wallet with the nudges in section 6.
- **D4. Recovery authentication.** The server verifies the passkey assertion before it returns a ciphertext.
- **D5. Banner threshold.** 20 USDC.
- **D6. Device-key copy of the seed on PRF phones.** No. The gap in section 8 is accepted.
- **D7. Passkey RP id.** Testnet will live on a subdomain of the Orchid domain. The domain is not defined yet. **Blocker:** no passkey code is implemented until it is, because the RP id is permanent.
- **D8. PRF device test.** Run it on cheap Android phones before implementation.

Still open: the mainnet amount in D2 and the domain in D7.

## Sources

- WebAuthn Level 3, PRF extension: <https://www.w3.org/TR/webauthn-3/#prf-extension>
- MDN, WebAuthn extensions: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions>
- MDN browser compat data, `CredentialsContainer`: <https://github.com/mdn/browser-compat-data/blob/main/api/CredentialsContainer.json>
- MDN browser compat data, `PublicKeyCredential`: <https://github.com/mdn/browser-compat-data/blob/main/api/PublicKeyCredential.json>
- MDN, `getClientCapabilities()`: <https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/getClientCapabilities_static>
- MDN, `getPublicKey()`: <https://developer.mozilla.org/en-US/docs/Web/API/AuthenticatorAttestationResponse/getPublicKey>
- MDN, `importKey()`: <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey>
- MDN, `StorageManager.persist()`: <https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist>
- MDN, storage quotas and eviction: <https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria>
- WebKit, Safari 18.0: <https://webkit.org/blog/15865/webkit-features-in-safari-18-0/>
- WebKit, seven-day storage cap: <https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/>
- passkeys.dev, device support: <https://passkeys.dev/device-support/>
- passkeys.dev, Android reference: <https://passkeys.dev/docs/reference/android/>
- passkeys.dev, iOS reference: <https://passkeys.dev/docs/reference/ios/>
- SEP-0005: <https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md>
- SEP-0010: <https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md>
- BIP-39: <https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki>
- SLIP-0010: <https://github.com/satoshilabs/slips/blob/master/slip-0010.md>
- Stellar, sponsored reserves: <https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves>
- Stellar, list of operations (Account Merge): <https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations>
- Stellar, lumens and base reserves: <https://developers.stellar.org/docs/learn/fundamentals/lumens>
- Family, account: <https://family.co/support/family-account>
- Family, recovery phrase: <https://family.co/support/view-your-security-recovery-phrase>
- Cavos: <https://cavos.xyz/compare/web3auth>
