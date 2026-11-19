import { draftPlan } from "../src/stellar/asset-plans";
import { draftClaimable } from "../src/stellar/asset-envelopes";
import type {
  Holdings,
  ClaimableEntry,
} from "../src/server/ledger-assets.server";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import { baseAsset } from "../src/contract";
import { beforeAll, beforeEach, expect } from "@effect/vitest";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { databaseLayer, makeDatabase } from "@workspace/db";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Approval,
  Opened,
  OpeningDraft,
  OpeningPending,
  PositiveAmount,
  Recipient,
  RecoveryDraft,
  SigningRequest,
  TransferDraft,
  TransferId,
  TransferOrder,
  Amount,
  Username,
  WalletClaim,
} from "../src/contract";
import {
  type AccountState,
  Chain,
  ChainUnreachable,
  Sealed,
  type Settlement,
  Undecided,
} from "../src/server/Chain.server";
import {
  KnownExchangeMemo,
  exchangeMemoFor,
} from "../src/server/exchange-memos.server";
import { Directory } from "../src/server/Directory.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { WalletSettings } from "../src/server/settings.server";
import {
  PaymentFacts,
  readEnvelope,
  draftOpening,
  draftPayment,
  draftRecovery,
  signingPayload,
} from "../src/stellar/envelopes";
import { network, networkPassphrase } from "../src/stellar/network";

export const dbLayer = databaseLayer({
  connectionString:
    "postgres://orchid:orchid-local@127.0.0.1:55433/wallet_test",
});

export const stores = Layer.mergeAll(
  Directory.layer,
  Transfers.layer,
  AssetOrders.layer,
  Backups.layer,
).pipe(Layer.provide(dbLayer));

export const sponsor = Keypair.random();
export const feePayer = Keypair.random();

export const reserveSponsor = Schema.decodeSync(AccountAddress)(
  sponsor.publicKey(),
);

export const passkeyOrigin = "http://localhost:3000";

export const settings = Layer.succeed(WalletSettings, {
  rpcUrl: "https://soroban-testnet.stellar.org",
  reserveSponsorSecret: Redacted.make(sponsor.secret()),
  feePayerSecret: Redacted.make(feePayer.secret()),
  passkeyOrigins: [passkeyOrigin],
});

export const realChain = Chain.layer.pipe(Layer.provide(settings));

export const world = {
  accounts: new Map<AccountAddress, AccountState>(),
  evidence: new Map<string, Settlement>(),
  submitted: new Array<Sealed>(),
  exchangeMemos: new Array<KnownExchangeMemo>(),
  failSubmit: false,
  holdings: new Map<AccountAddress, Holdings>(),
  claimables: new Map<string, ClaimableEntry>(),
};

export const fakeChain = Layer.effect(
  Chain,
  Effect.gen(function* () {
    const real = yield* Chain;

    const account = (address: AccountAddress) =>
      Effect.succeed(Option.fromNullishOr(world.accounts.get(address)));

    const request = (envelope: SigningRequest["envelope"], maxTime: number) =>
      new SigningRequest({
        envelope,
        expiresAt: DateTime.makeUnsafe(maxTime * 1000),
      });

    return Chain.of({
      ...real,
      memoRequiredFor: (address) =>
        exchangeMemoFor(address, world.exchangeMemos),
      account,
      holdings: (address, assets) =>
        world.holdings.has(address)
          ? Effect.succeed(Option.fromNullishOr(world.holdings.get(address)))
          : account(address).pipe(
              Effect.map(
                Option.map((state) => ({
                  account: state,
                  reserveSponsor: state.accountSponsored
                    ? Option.some(reserveSponsor)
                    : Option.none(),
                  native: Schema.decodeSync(Amount)(
                    state.nativeBalance.toString(),
                  ),
                  reserves: { subentries: 1, sponsored: 3, sponsoring: 0 },
                  lines: assets.flatMap((asset) =>
                    asset.code === baseAsset.code &&
                    asset.issuer === baseAsset.issuer &&
                    Option.isSome(state.balance)
                      ? [
                          {
                            asset,
                            balance: state.balance.value,
                            spendable: state.balance.value,
                            authorized: true,
                            sponsored: true,
                          },
                        ]
                      : [],
                  ),
                })),
              ),
            ),
      claimable: (ids) =>
        Effect.succeed(
          ids.flatMap((id) => {
            const entry = world.claimables.get(id);

            return entry ? [entry] : [];
          }),
        ),
      issuer: () => Effect.succeed(Option.some({ authRequired: false })),
      draftAsset: (address, plan) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftPlan(plan, {
              source: new Account(
                address,
                world.accounts.get(address)?.sequence ?? "100",
              ),
              reserveSponsor,
              minTime: now,
              maxTime: now + 120,
            }),
            now + 120,
          );
        }),
      draftClaimable: (from, to, asset, amount) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftClaimable({
              source: new Account(
                from,
                world.accounts.get(from)?.sequence ?? "100",
              ),
              reserveSponsor,
              to,
              asset,
              amount,
              minTime: now,
              maxTime: now + 120,
            }),
            now + 120,
          );
        }),
      pastOpeningWindow: (sealed) =>
        Effect.succeed(DateTime.toEpochMillis(sealed.expiresAt) < Date.now()),
      balance: (address) =>
        account(address).pipe(
          Effect.map(Option.flatMap((state) => state.balance)),
        ),
      draftOpening: (address) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftOpening({
              source: new Account(reserveSponsor, "100"),
              address,
              createAccount: !world.accounts.has(address),
              minTime: now,
              maxTime: now + 120,
            }),
            now + 120,
          );
        }),
      draftPayment: (from, to, asset, amount, memo) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftPayment({
              source: new Account(
                from,
                world.accounts.get(from)?.sequence ?? "100",
              ),
              to,
              asset,
              amount,
              memo,
              minTime: now,
              maxTime: now + 120,
            }),
            now + 120,
          );
        }),
      draftRecovery: (address) =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);

          return request(
            draftRecovery({
              source: new Account(
                address,
                world.accounts.get(address)?.sequence ?? "100",
              ),
              reserveSponsor,
              minTime: now + 60,
              maxTime: now + 180,
            }),
            now + 180,
          );
        }),
      submit: (sealed) =>
        Effect.gen(function* () {
          if (world.failSubmit)
            return yield* new ChainUnreachable({
              cause: new Error("Network dropped"),
            });

          world.submitted.push(sealed);

          const outer = TransactionBuilder.fromXDR(
            sealed.envelope,
            networkPassphrase,
          );

          const inner =
            outer instanceof FeeBumpTransaction
              ? outer.innerTransaction
              : outer;

          const first = inner.operations[0];

          if (first?.type === "beginSponsoringFutureReserves") {
            const address = Schema.decodeSync(AccountAddress)(
              first.sponsoredId,
            );

            world.accounts.set(address, {
              sequence: world.accounts.get(address)?.sequence ?? "1000",
              ledger: 100,
              accountSponsored: true,
              sponsored: true,
              nativeBalance: 0n,
              balance: Option.some(Schema.decodeSync(Amount)("0")),
            });
          }
        }),
      settlement: (sealed) =>
        Effect.succeed(world.evidence.get(sealed.hash) ?? new Undecided()),
    });
  }),
).pipe(Layer.provide(realChain));

export const walletLayer = Wallet.serviceLayer.pipe(
  Layer.provide(stores),
  Layer.provide(fakeChain),
  Layer.provide(settings),
);

export const walletTestLayer = Layer.mergeAll(walletLayer, stores, dbLayer);

export const addressOf = (key: Keypair) =>
  Schema.decodeSync(AccountAddress)(key.publicKey());

export const registerExchange = (address: AccountAddress) => {
  const entry = new KnownExchangeMemo({
    network,
    address,
    exchange: "Synthetic exchange fixture",
    source: "https://example.com/fixtures/stellar-testnet-memo-required",
  });

  world.exchangeMemos.push(entry);

  return entry;
};

export const approve = (request: SigningRequest, key: Keypair) =>
  Option.some(
    new Approval({ signature: key.sign(signingPayload(request.envelope)) }),
  );

export const claimFor = (key: Keypair, name: string) =>
  new WalletClaim({
    address: addressOf(key),
    username: Schema.decodeSync(Username)(name),
  });

export const opening = (
  claim: WalletClaim,
  approval: Option.Option<Approval> = Option.none(),
) => Wallet.use((wallet) => wallet.open(claim, approval));

export const create = Effect.fn(function* (key: Keypair, name: string) {
  const claim = claimFor(key, name);
  const draft = yield* opening(claim);

  if (!(draft instanceof OpeningDraft))
    throw new Error("Expected opening draft");

  expect(yield* opening(claim, approve(draft.request, key))).toBeInstanceOf(
    OpeningPending,
  );

  const recovery = yield* opening(claim);

  if (!(recovery instanceof RecoveryDraft))
    throw new Error("Expected recovery draft");

  expect(yield* opening(claim, approve(recovery.request, key))).toBeInstanceOf(
    Opened,
  );

  return claim;
});

export const orderFor = (sender: Keypair, to: Recipient) =>
  new TransferOrder({
    asset: baseAsset,
    id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
    from: addressOf(sender),
    to,
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
  });

export const send = (
  order: TransferOrder,
  approval: Option.Option<Approval> = Option.none(),
) => Wallet.use((wallet) => wallet.transfer(order, approval));

export const placeholderRequest = () =>
  new SigningRequest({
    envelope: Schema.decodeSync(SigningRequest.fields.envelope)("AAAA"),
    expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
  });

export const placeholderSealed = () =>
  new Sealed({
    envelope: "AAAA",
    hash: "00".repeat(32),
    expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
  });

export const fundHolder = (key: Keypair, sequence = "1000") =>
  world.accounts.set(addressOf(key), {
    sequence,
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("50000000")),
  });

export const paymentSequence = (draft: TransferDraft) => {
  const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

  if (!(facts instanceof PaymentFacts))
    throw new Error("Expected payment facts");

  return facts.sequence;
};

export function useDisposableDatabase() {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDatabase();

        yield* migrate(db, {
          migrationsFolder: `${import.meta.dirname}/../drizzle`,
        });
        yield* migrate(db, {
          migrationsFolder: `${import.meta.dirname}/../drizzle`,
        });
      }).pipe(Effect.provide(dbLayer)),
    );
  });

  beforeEach(async () => {
    world.accounts.clear();
    world.holdings.clear();
    world.claimables.clear();
    world.evidence.clear();
    world.submitted.length = 0;
    world.exchangeMemos.length = 0;
    world.failSubmit = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDatabase();

        yield* db.execute(
          sql`truncate asset_orders, trustlines, transfers, usernames, wallets, backups, passkey_challenges`,
        );
      }).pipe(Effect.provide(dbLayer)),
    );
  });
}
