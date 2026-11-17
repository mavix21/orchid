# Sketch: candidates

Part of the [sketch index](sketch.md). The four designs considered, and the synthesis that picked A.

## 2. Candidates

Each candidate is a whole shape that runs from the device to the chain. All four keep the device as the only holder of the user's key.

### A. Relay: the device builds and signs; the server checks, pays the fee, submits and records

- The device builds the payment from a server quote (recipient address, sequence, deadline), signs it, and stores the signed envelope in a local outbox. It then sends the envelope to the server.
- The server checks the envelope against the transfer policy, fee-bumps it once, stores that exact envelope keyed by the inner transaction hash, submits it, and drives it to a result. It reconciles any row still pending whenever that row is read.
- Enrollment is the exception: the sponsor has to be the source, so the server builds that transaction and the device checks it before signing.
- Public surface: the device entry (the `Wallet` service with 5 members) and the server entry (`walletCall`, `walletServerLayer`).
- Red-flag screen:
  - Shallow: no. One call per user decision.
  - Leakage: each transaction layout lives in one shared file that has both the build half and the check half.
  - Temporal decomposition: no. Files are grouped by knowledge (enrollment, transfer, directory, chain).
  - Pass-through: only the single Start server function, which adds env and layer provisioning.
  - Split ownership: the outbox (device) holds an envelope only until the server acknowledges it. Status is written by the server only.
  - Two ways to do one task: no.
  - Importable internals: blocked by `exports` plus `*.server.ts`.
  - Hand-synced list: calls are listed once, and replies are keyed by `satisfies` and an exhaustive `Match`.
  - **Viable.**

### B. Direct: the device talks to Stellar RPC; the server only resolves usernames and co-signs

- The device fetches its sequence from RPC, builds and signs the transaction, asks the server to "co-sign" (sponsor signature or fee bump), submits to RPC itself, polls `getTransaction`, and reads activity from RPC.
- Postgres holds only usernames.
- Red-flag screen:
  - **Leakage**: the RPC URL, RPC status codes and result XDR parsing live on the device, while the policy check lives on the co-signer.
  - **Shallow server**: "co-sign" is a sign-this-blob method, and callers coordinate fetch-sequence, build, co-sign, submit and poll for one send.
  - **Two ways later**: pot refunds and payment links are server-originated, so they would need a second submit path.
  - History disappears after about 7 days of RPC retention, and again at each testnet reset.
  - The client bundle is heavier (`rpc` plus polling).
  - **Rejected.**

### C. Orchestrator: the server builds every transaction; the device is a checking signer

- The device calls `prepare(to, amount, idempotencyKey)`. The server stores an intent, builds the transaction and returns it. The device checks and signs it, and the server submits it.
- There is no device outbox: a signature that never reaches the server is simply never submitted.
- Red-flag screen:
  - Same surface depth as A.
  - Two round trips on every send.
  - The server gains an `awaiting_signature` state.
  - The device still needs the SDK to decode and check every server-built transaction.
  - The client-generated idempotency key duplicates what the inner transaction hash already gives.
  - **Viable, but costlier per send than A.**

### D. Smart account: a Soroban C-address with passkey signing and a relayer

- There is no trustline or sequence for the user, the signer is a passkey, and it is ready for agent accounts.
- Red-flag screen:
  - Not a red flag but a **product blocker**: a SAC `transfer` cannot carry a memo, only a muxed ID, so Lemon-style memo withdrawals break.
  - It adds contract deployment, simulation, a relayer and more stack.
  - The testnet reset on 2026-12-16 wipes deployed contracts.
  - **Rejected for now.** It stays possible later because no Stellar concept leaves the wallet package.

### Synthesis

Base: **A**.

- Grafted from C: the server drives every acknowledged transfer to a result and owns its status, so the device is not needed after acknowledgement. Enrollment also uses C's pattern: the server builds, the device checks and signs.
- Grafted from B: the chain is the only source of balances (no balance table), and the inner transaction hash is the idempotency key.
- Grafted from D: all Stellar types stay inside the package, so the account kind can change behind `Wallet`.
