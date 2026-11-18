# Orchid

Orchid's wallet domain covers sponsored Stellar accounts and payments between usernames or external addresses.

## Language

**Wallet**: The user's Orchid payment identity, associated with a Stellar account and a permanent username.
_Avoid_: Account when referring to the complete Orchid identity.

**Secret phrase**: The words on the user's device from which the wallet's signing key derives; whoever holds them controls the wallet.
_Avoid_: Recovery phrase, seed, private key when referring to the words.

**Backup**: The passkey-encrypted copy of a wallet's secret phrase that Orchid holds; only the passkey that encrypted it can unlock it.
_Avoid_: Recovery, seed backup.

**Restore**: Recovering a wallet on a device from its backup, after the device proves it holds the passkey.
_Avoid_: Recovery, reserve recovery, import.

**Account address**: The public Stellar address identifying an account on the network.
_Avoid_: Username, private key.

**Username**: A permanent name bound to one account address. It resolves as a recipient while the wallet is active and stays bound after reserve recovery.
_Avoid_: Temporary alias, recyclable handle.

**Opening**: Establishing or repairing the sponsored account and base trustline so a wallet can become active.

**Reserve sponsor**: The account providing the Stellar reserves needed for sponsored accounts and trustlines.
_Avoid_: Fee payer when referring to reserves.

**Fee payer**: The account paying transaction fees; this role is distinct from reserve sponsorship.

**Asset**: XLM, or an issued asset identified by both its code and issuer.
_Avoid_: Symbol alone when identifying an issued asset.

**Trustline**: An account's relationship with an issued asset that allows it to hold that asset.

**Transfer order**: A uniquely identified instruction to send an asset amount to a recipient, with an optional external payment memo.
_Avoid_: Transaction when referring to the user's instruction rather than its network execution.

**Asset order**: A uniquely identified instruction to open or close a trustline, or claim a claimable balance.

**Draft**: An unsigned transaction offered for approval before its expiry.
_Avoid_: Completed transfer.

**Approval**: The user's signature authorizing the requested transaction.
_Avoid_: Settlement.

**Settlement**: A transaction's successful outcome established by ledger evidence.
_Avoid_: Submission acknowledgement.

**Payment memo**: A text or numeric reference accompanying a payment to an external address, such as an exchange deposit reference.

**Reserve recovery**: Returning eligible sponsored reserves to the sponsor using the user's pre-signed recovery transaction.
_Avoid_: Key recovery, passkey recovery.

**Sweep**: Scheduled reconciliation of pending operations and eligible reserve recovery.
