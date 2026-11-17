# Key backup and recovery

Design only, no code. This entire passkey/backup step, including `protect`, `recover` and the enrollment envelope layout, follows the server-first step in `sketch.md`. It extends the approved base in `rationale.md` and settles its "Key backup" decision. The owner's decisions are in [section 12](backup-risks.md#12-decisions). Option 3 is given: a SEP-0005 phrase is the source of truth, it is never shown at sign-up, and a passkey protects it.

Each claim is marked by how it was checked: **[spec]** read in the W3C or Stellar text, **[docs]** read in vendor documentation, **[unverified]** not confirmed from an official source. [Section 11](backup-risks.md#11-not-verified) collects the unverified ones.

## Contents

- [Where the secret lives](backup-keys.md): [1. Summary](backup-keys.md#1-summary); [2. Where the secret lives](backup-keys.md#2-where-the-secret-lives); [3. Key hierarchy](backup-keys.md#3-key-hierarchy).
- [Sign-up, recovery and export](backup-flows.md): [4. Sign-up](backup-flows.md#4-sign-up); [5. Recovery on a new phone](backup-flows.md#5-recovery-on-a-new-phone); [7. Showing the phrase (export)](backup-flows.md#7-showing-the-phrase-export).
- [When PRF is not available](backup-prf.md): [6. When PRF is not available](backup-prf.md#6-when-prf-is-not-available).
- [Passkeys and the wallet package](backup-passkeys.md): [8. More passkeys, and none](backup-passkeys.md#8-more-passkeys-and-none); [9. Fit with `packages/wallet`](backup-passkeys.md#9-fit-with-packageswallet).
- [Threats, open checks and decisions](backup-risks.md): [10. Threats and tradeoffs](backup-risks.md#10-threats-and-tradeoffs); [11. Not verified](backup-risks.md#11-not-verified); [12. Decisions](backup-risks.md#12-decisions).

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
