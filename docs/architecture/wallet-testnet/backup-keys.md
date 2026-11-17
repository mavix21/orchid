# Key backup: where the secret lives

Part of [Key backup and recovery](backup.md), which also defines the **[spec]**, **[docs]** and **[unverified]** tags and lists the sources. The summary, storage of the secret, and the key hierarchy.

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
