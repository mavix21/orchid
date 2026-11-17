# Key backup: when PRF is not available

Part of [Key backup and recovery](backup.md), which also defines the **[spec]**, **[docs]** and **[unverified]** tags and lists the sources. The device-only fallback and what is known about PRF support.

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

"Save now" is the reveal flow in [section 7](backup-flows.md#7-showing-the-phrase-export), followed by a check that asks for three of the words. Passing it clears the banner. The flag is local to the phone.

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

A browser version is not enough. PRF also depends on the passkey provider and the OS, and no official matrix covers that. See [section 11](backup-risks.md#11-not-verified).

### PRF on Android: implementation rules

Chrome supports `prf` for `create()` and `get()` on Android since Chrome 116 (August 2023); Android WebView does not. Samsung Internet and Edge mirror Chrome. Firefox Android supports PRF since 149; MDN's Firefox Android `get()` row is stale. See [Chromium](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI), [MDN compat data](https://github.com/mdn/browser-compat-data/blob/main/api/CredentialsContainer.json), and [Mozilla](https://bugzilla.mozilla.org/show_bug.cgi?id=1958716).

Google's Adam Langley says Google Password Manager passkeys return PRF ([WebAuthn issue](https://github.com/w3c/webauthn/issues/1830#issuecomment-1774092530), [Chromium discussion](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI)). Independent [Corbado tests](https://www.corbado.com/blog/passkeys-prf-webauthn) in 2026 report Google Password Manager success of 91–100% at `create()` and 100% at `get()`. They also report Samsung Pass often returns no value at `create()` but does at `get()`, Bitwarden is unreliable on Android, and Dashlane returns none. These provider results are independent tests, not official guarantees.

- Request `prf.eval` at `create()`. If `results.first` is missing, call `get()` with the same input before concluding PRF is unavailable; only then show a second sheet.
- Request a discoverable credential with `residentKey: "required"` so Android routes to Google Password Manager instead of the security-key chooser.
- Do not rely on `getClientCapabilities()['extension:prf']` alone (Chrome 133+): it signals browser support for forwarding the extension, not a PRF result from the provider. See [MDN](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/getClientCapabilities_static).

### PRF across devices and desktop

[WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/#sctn-prf-extension) defines a PRF per credential: the same credential and salt yield the same output. CTAP `hmac-secret` has separate seeds with and without user verification; request `userVerification: "required"` on both `create()` and `get()`.

Desktop Chrome supports PRF with Google Password Manager passkeys, but its local Chrome profile authenticator does not; Chromium also supports PRF over hybrid (QR). See [Adam Langley's Chromium discussion](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI). iCloud Keychain and Safari support PRF since iOS 18 and macOS 15. The iCloud platform path returns the same output on Mac, iPhone and iPad. Hybrid on iOS 18.0–18.3 returned a different output; Apple reported a fix in the iOS 18.4 / macOS 15.4 betas. Do not use hybrid recovery on older iOS. See [Stack Overflow](https://stackoverflow.com/questions/79026100) and the [Apple developer forum](https://developer.apple.com/forums/thread/764730).

Google has not explicitly confirmed identical PRF output for a synced Google Password Manager passkey on Android and desktop Chrome [unverified]. Once code exists, create a passkey in Android Chrome and decrypt in desktop Chrome on a Mac; also test iPhone Safari to Mac Safari and back.

`http://localhost` is a valid WebAuthn origin, but its passkeys are scoped to localhost. The demo uses a disposable `workers.dev` host; see D7 before creating passkeys.
