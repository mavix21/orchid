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
_Avoid_: Recovery, import.

**Account address**: The public Stellar address identifying an account on the network.
_Avoid_: Username, private key.

**Username**: A permanent name bound to one account address when the wallet is created. It resolves as a recipient while the wallet is unopened or active and stays bound if the wallet's account leaves the network.
_Avoid_: Temporary alias, recyclable handle.

**Unopened wallet**: A wallet whose username is bound and whose backup is stored, but whose sponsored account does not exist on the network yet. Creating a wallet signs its opening, so a new wallet stays unopened only until that opening settles, or if it fails.
_Avoid_: Inactive wallet, pending wallet.

**Opening**: Establishing or repairing the sponsored account and base trustline so an unopened wallet, or one whose account left the network, can become active. Orchid never closes an open wallet to take its reserves back.

**Reserve sponsor**: The account providing the Stellar reserves needed for sponsored accounts and trustlines.
_Avoid_: Fee payer when referring to reserves.

**Fee payer**: The account paying transaction fees; this role is distinct from reserve sponsorship.

**Channel**: An Orchid account that holds no funds and serves as the transaction source of an opening or a link receive, so drafts made at the same time never compete for one sequence number. Each draft leases its own channel until the draft settles or expires.
_Avoid_: Fee payer or reserve sponsor when referring to the transaction source.

**Asset**: XLM, or an issued asset identified by both its code and issuer.
_Avoid_: Symbol alone when identifying an issued asset.

**Trustline**: An account's relationship with an issued asset that allows it to hold that asset.

**Transfer order**: A uniquely identified instruction to send an asset amount to a recipient, with an optional external payment memo.
_Avoid_: Transaction when referring to the user's instruction rather than its network execution.

**Transfer intent**: What the user entered to send (recipient, asset, amount and optional payment memo) before the device turns it into a transfer order.
_Avoid_: Order when referring to the entry before it has an id.

**Payment link**: A URL that carries a claimable balance's link code, so whoever opens it can receive the funds or send them to another address.

**Link code**: The short checksummed code after the `#` in a payment link. The device derives the link account's key from it; the server never receives it.
_Avoid_: Link secret when referring to what the URL carries.

**Asset order**: A uniquely identified instruction to open or close a trustline, or claim a claimable balance.

**Draft**: An unsigned transaction offered for approval before its expiry.
_Avoid_: Completed transfer.

**Approval**: The user's signature authorizing the requested transaction.
_Avoid_: Settlement.

**Settlement**: A transaction's successful outcome established by ledger evidence.
_Avoid_: Submission acknowledgement.

**Payment memo**: A text or numeric reference accompanying a payment to an external address, such as an exchange deposit reference.

**Wallet session**: Orchid's proof, given after the wallet's passkey is verified, that requests come from the wallet's holder. It lets the device read the wallet and request **Drafts**; it never authorizes an **Approval**.
_Avoid_: Login when talking to users.

**Embedded browser**: The in-app browser of an app such as Instagram, Facebook, TikTok or WhatsApp. It cannot evaluate a passkey's PRF, so Orchid hands the user off to their own browser before any passkey ceremony.
_Avoid_: Webview when talking to users.

**Deposit**: USDC that reached a wallet from outside Orchid, such as an exchange or another wallet app, read from the network's asset events and listed in activity.
_Avoid_: Payment or transfer when the money did not go through Orchid.

**Sweep**: Hourly backstop that reconciles pending operations the queue left unfinished, cleans up received links, and prunes expired drafts and abandoned openings.

## Names in the app

The app is localized in Spanish and English. These product names are translated:

| Spanish      | English      |
| ------------ | ------------ |
| Ahorro       | Savings      |
| Mis links    | My links     |
| Link de pago | Payment link |
| Inicio       | Home         |
| Actividad    | Activity     |
| Enviar       | Send         |
| Recibir      | Receive      |
| Ajustes      | Settings     |
