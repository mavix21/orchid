import assert from "node:assert/strict";
import { Account, type Keypair, rpc } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type Approvals,
  Opened,
  OpeningDraft,
  OpeningPending,
  type OpenStep,
  type RecoveryDraft,
  Username,
  WalletClaim,
} from "../src/contract";
import { Chain, Sealed } from "../src/server/Chain.server";
import { Directory, type WalletRow } from "../src/server/Directory.server";
import type { Transfers } from "../src/server/Transfers.server";
import type { Wallet } from "../src/server/Wallet.server";
import {
  OpeningFacts,
  RecoveryFacts,
  pinnedSequence,
  readEnvelope,
} from "../src/stellar/envelopes";
import {
  type OpeningSchedule,
  draftOpeningWithRecovery,
} from "../src/stellar/opening-drafts";
import { horizon } from "./testnet-funding";

const addressOf = (key: Keypair) =>
  Schema.decodeSync(AccountAddress)(key.publicKey());

export interface PairedCreationDependencies {
  readonly sponsor: Keypair;
  readonly server: rpc.Server;
  readonly run: <A, E>(
    program: Effect.Effect<A, E, Wallet | Chain | Directory | Transfers>,
  ) => Promise<A>;
  readonly opening: (
    claim: WalletClaim,
    approvals?: Option.Option<Approvals>,
  ) => Promise<OpenStep>;
  readonly approvedBy: (
    key: Keypair,
    draft: OpeningDraft | RecoveryDraft,
  ) => Option.Option<Approvals>;
  readonly walletRow: (address: AccountAddress) => Promise<WalletRow>;
  readonly waitApplied: (sealed: Sealed) => Promise<void>;
  readonly remember: (label: string, hash: string) => void;
}

const shortSchedule: OpeningSchedule = {
  lifetime: 60,
  ledgers: 20,
  recoveryDelay: 5,
  recoveryWindow: 600,
};

export const pairedCreation =
  (dependencies: PairedCreationDependencies) =>
  async (key: Keypair, name: string) => {
    const {
      sponsor,
      server,
      run,
      opening,
      approvedBy,
      walletRow,
      waitApplied,
      remember,
    } = dependencies;

    const address = addressOf(key);

    const claim = new WalletClaim({
      address,
      username: Schema.decodeSync(Username)(name),
    });

    assert.ok((await opening(claim)) instanceof OpeningDraft);

    const sponsorState = Option.getOrThrow(
      await run(Chain.use((chain) => chain.account(addressOf(sponsor)))),
    );

    const initialRow = await walletRow(address);

    await run(
      Directory.use((directory) =>
        directory.draft(
          initialRow,
          draftOpeningWithRecovery({
            source: new Account(sponsor.publicKey(), sponsorState.sequence),
            address,
            reserveSponsor: addressOf(sponsor),
            observedSequence: undefined,
            now: Math.floor(Date.now() / 1000),
            latestLedger: sponsorState.ledger,
            pinSequence: true,
            schedule: shortSchedule,
          }),
        ),
      ),
    );

    const draft = await opening(claim);

    assert.ok(draft instanceof OpeningDraft);
    assert.ok(draft.recovery !== undefined);

    const openingFacts = Option.getOrThrow(
      readEnvelope(draft.request.envelope),
    );

    assert.ok(openingFacts instanceof OpeningFacts);
    assert.ok(openingFacts.window !== undefined);

    const pinned = pinnedSequence(openingFacts.window);

    assert.ok(
      (await opening(claim, approvedBy(key, draft))) instanceof OpeningPending,
    );

    const stored = await walletRow(address);

    assert.ok(
      stored.attemptEnvelope &&
        stored.attemptHash &&
        stored.attemptExpiresAt &&
        stored.pairedRecoveryEnvelope &&
        stored.pairedRecoveryHash,
    );

    const sealed = new Sealed({
      envelope: stored.attemptEnvelope,
      hash: stored.attemptHash,
      expiresAt: DateTime.makeUnsafe(stored.attemptExpiresAt),
    });

    await waitApplied(sealed);
    remember(`${name} opening`, sealed.hash);

    const sponsorship = Option.getOrThrow(
      await run(Chain.use((chain) => chain.account(address))),
    );

    assert.ok(
      sponsorship.accountSponsored && sponsorship.sponsored,
      "Raw extXdr must identify Orchid as both sponsors",
    );

    const account = await horizon.loadAccount(address);

    const native = account.balances.find(
      (balance) => balance.asset_type === "native",
    );

    assert.equal(native?.balance, "0.0000000");
    assert.equal(account.num_sponsored, 3);
    assert.equal(
      account.sequence,
      pinned.toString(),
      "CAP-21 opening must leave the created account at N<<32",
    );

    assert.equal(
      (await server.getTransaction(stored.pairedRecoveryHash)).status,
      rpc.Api.GetTransactionStatus.NOT_FOUND,
    );
    assert.ok((await opening(claim)) instanceof Opened);

    const active = await walletRow(address);

    assert.ok(
      active.recoveryEnvelope && active.recoveryHash && active.recoveryMaxTime,
    );
    assert.equal(active.recoverySequence, (pinned + 1n).toString());

    const recoveryFacts = Option.getOrThrow(
      readEnvelope(draft.recovery.envelope),
    );

    assert.ok(recoveryFacts instanceof RecoveryFacts);
    assert.ok(recoveryFacts.minLedger !== undefined);

    return {
      claim,
      minTime: recoveryFacts.minTime,
      minLedger: recoveryFacts.minLedger,
      sealed: new Sealed({
        envelope: active.recoveryEnvelope,
        hash: active.recoveryHash,
        expiresAt: DateTime.makeUnsafe(active.recoveryMaxTime),
      }),
    };
  };
