# Key backup: threats, open checks and decisions

Part of [Key backup and recovery](backup.md), which also defines the **[spec]**, **[docs]** and **[unverified]** tags and lists the sources. Threats and tradeoffs, what is not verified, and the owner's decisions.

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
| Orchid's domain changes                         | Every passkey stops working, because a passkey is bound to its RP id. | Demo wallets are disposable; see D7 before creating non-disposable passkeys.                                           |
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
2. Whether Google Password Manager sync yields the same PRF output on Android and desktop Chrome; see the planned test in [section 6](backup-prf.md#6-when-prf-is-not-available).
3. PRF recovery over the cross-device (QR) path between the target Android and iOS devices.
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
- **D3. Phones without PRF.** Allowed. They get a device-only wallet with the nudges in [section 6](backup-prf.md#6-when-prf-is-not-available).
- **D4. Recovery authentication.** The server verifies the passkey assertion before it returns a ciphertext.
- **D5. Banner threshold.** 20 USDC.
- **D6. Device-key copy of the seed on PRF phones.** No. The gap in [section 8](backup-passkeys.md#8-more-passkeys-and-none) is accepted.
- **D7. Passkey RP ID.** No domain has been bought. The demo uses a `workers.dev` host and its full host as RP ID, never `<account>.workers.dev`. Demo wallets are disposable: a domain change breaks passkey restore, and device-only wallets without a saved phrase lose funds. Buy the real domain before creating non-disposable passkeys. Related Origin Requests may bridge domains, but browser support is conflicting.
- **D8. PRF device test.** Run it on cheap Android phones before implementation.

Still open: the mainnet amount in D2 and the domain in D7.
