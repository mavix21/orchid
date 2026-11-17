# Key backup: sign-up, recovery and export

Part of [Key backup and recovery](backup.md), which also defines the **[spec]**, **[docs]** and **[unverified]** tags and lists the sources. The user-facing flows.

## 4. Sign-up

The user sees: type a username, tap Create, one system passkey sheet, home screen. No words.

```text
create(username):
  1. E = random; derive address; import signing handle; keep E in memory
  2. port.open(claim, none)            → checks the username (reserves nothing), returns the opening draft
                                         (a taken name stops here, before any passkey exists)
  3. navigator.credentials.create      rp.id = Orchid's domain, user.name = username,
                                         user.id = 32 random bytes, residentKey "required",
                                         userVerification "required", prf.eval.first = constant
       prf.results.first present       → use it
       prf.results.first absent        → navigator.credentials.get with the same input (second sheet)
       no PRF output from get()        → [section 6](backup-prf.md#6-when-prf-is-not-available), the fallback
  4. wrap E; store the wrap in IndexedDB; drop E from memory
  5. approve the opening draft; port.open(claim, approval) → binds the name; replay until Opened
                                         (a name lost to a concurrent signer returns UsernameTaken here)
  6. port.protect(enrollment, …)       → upload the wrap ([section 8](backup-passkeys.md#8-more-passkeys-and-none)). Replayed on next launch if it fails
```

- **One sheet or two.** The spec says not all authenticators evaluate the PRF at creation, and then "an assertion is needed in order to obtain the outputs" [spec]. MDN repeats it [docs]. Provider results vary: see the Android implementation rules below. Worst case is two sheets back to back.
- **Username first.** Step 2 runs before step 3 so a name that is already taken never leaves an orphan passkey in the user's password manager. Only a race lost at step 5 can still leave one.
- **`user.id` is random.** The spec forbids personal data in the user handle [spec].
- **Crash safety.** The signing handle is saved in step 1 and the wrap in step 4, so every later step is a replay. If the app dies between 1 and 4, `E` is lost before anything was signed. Nothing was reserved, so the name stays free for the next attempt.

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
- Another wallet can remove the trustline or merge the account. `Chain.balance` then returns none for an `active` wallet. `overview` returns `NeedsReopening`, marks it `recovered`, and replayable `open` repairs it with the same username and device key before repeating recovery signing.
