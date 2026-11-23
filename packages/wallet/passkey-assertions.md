# Passkey assertions

`verifyPinnedAssertion(ceremony, relyingParty, credential, intent)` is the device-side verification ceremony for a `PinnedCredential` (credential ID, SPKI public key and `ES256` or `RS256`). It issues a fresh random challenge, asks the ceremony (`browserAssertions`, with `browserRelyingParty()`) for a `get` pinned to that credential with user verification required, and verifies the signature, `webauthn.get` type, challenge, origin, RP ID hash, credential ID, UP and UV with `@passwordless-id/webauthn` without a counter check, so synced credentials with zero counters pass. The `Entry` intent sends no PRF extension and returns `EntryVerified`; an `Operation` intent names its `OperationPurpose` and PRF inputs and returns `OperationVerified` with the outputs wrapped in `Redacted`. Outcomes: `PasskeyCancelled`, `PasskeyFailed`, `WrongCredential`, `AssertionRejected` and `PrfOutputMissing`.

## Display lock

`unlock()` reads the stored `PinnedCredential` and verifies a fresh assertion with the `Entry` intent, which sends no PRF input, so it can never open the envelope or authorize a signature; it returns `Unlocked`, or `NoWallet`, `PasskeyCancelled`, `PasskeyFailed`, `WrongCredential`, `AssertionRejected`, `UnsupportedDevice` or `CorruptDeviceWallet`.

`makeDisplayLock(now)` holds the tab's display state in memory only and never reads storage; it starts `Locked`. `hide` masks an unlocked display immediately, `show` restores it when less than `resumeWindowMillis` (60 seconds) of wall-clock time has passed and locks it otherwise, and `relock` locks a page restored from the browser cache without a window.

Two kinds of pending verification follow different rules, because the platform may hide the page while its own prompt or share sheet is open. A secret-bearing completion (`begin` and `unlock(ticket)`, used by restore and enrollment) is voided by any `hide` or `relock`. An app-initiated entry (`attemptEntry`, `entryVerified`) survives a short hide: if it verifies while the page is hidden, only that verified result is held and the display is revealed on `show` when the hidden interval was under the window. The attempt expires on a hidden interval of the window or longer, `relock`, `cancelEntry` or a replacing `attemptEntry`, after which a fresh verification is required.

Verified `Restored` and `WalletEnrolled` outcomes unlock the display of the tab that ran them. Openings have no assertion path yet, so they unlock nothing.
