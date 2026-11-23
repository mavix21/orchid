import { beforeAll, beforeEach, expect } from "@effect/vitest";
import {
  Account,
  Claimant,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Database, databaseLayer } from "@workspace/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as TestClock from "effect/testing/TestClock";
import {
  AccountAddress,
  AddressRecipient,
  Amount,
  Approval,
  AssetCode,
  BalanceId,
  IssuedAsset,
  PositiveAmount,
  type Recipient,
  SigningRequest,
  TransferId,
  TransferOrder,
  Username,
  WalletClaim,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { signingKey } from "../src/device/signing";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import {
  type AccountState,
  Applied,
  Chain,
  ChainUnreachable,
  type Sealed,
  type Settlement,
  Undecided,
} from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import {
  type KnownExchangeMemo,
  exchangeMemoFor,
} from "../src/server/exchange-memos.server";
import type {
  ClaimableEntry,
  Holdings,
} from "../src/server/ledger-assets.server";
import { WalletSettings } from "../src/server/settings.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import {
  draftClaimable,
  draftPaymentLink,
} from "../src/stellar/asset-envelopes";
import { draftPlan } from "../src/stellar/asset-plans";
import {
  draftOpening,
  draftPayment,
  draftRecovery,
  signingPayload,
} from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import { addressOf, enrolledDeviceWallet } from "./device-fixtures";
import {
  httpClientAnswering,
  jsonResponse,
  rpcMethod,
  testRpcUrl,
} from "./rpc-answering";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";

export { addressOf };

export const dbLayer = databaseLayer({
  connectionString:
    "postgres://orchid:orchid-local@127.0.0.1:55433/wallet_test",
});

const storesFor = <E>(db: Layer.Layer<Database, E>) =>
  Layer.mergeAll(
    Directory.layer,
    Transfers.layer,
    AssetOrders.layer,
    Backups.layer,
  ).pipe(Layer.provide(db));

const stores = storesFor(dbLayer);
export const sponsor = Keypair.random();
export const feePayer = Keypair.random();
export const reserveSponsor = addressOf(sponsor);
export const passkeyOrigin = "http://localhost:3000";

const settingsFor = (rpcUrl = "https://soroban-testnet.stellar.org") =>
  Layer.succeed(WalletSettings, {
    rpcUrl,
    reserveSponsorSecret: Redacted.make(sponsor.secret()),
    feePayerSecret: Redacted.make(feePayer.secret()),
    passkeyOrigins: [passkeyOrigin],
  });

const settings = settingsFor();

const realChain = Chain.layer.pipe(
  Layer.provide(settings),
  Layer.provide(FetchHttpClient.layer),
);

export const world = {
  accounts: new Map<AccountAddress, AccountState>(),
  evidence: new Map<string, Settlement>(),
  submitted: new Array<Sealed>(),
  exchangeMemos: new Array<KnownExchangeMemo>(),
  failSubmit: false,
  ledgerDown: false,
  unreadable: new Set<string>(),
  claimablesDown: false,
  holdings: new Map<AccountAddress, Holdings>(),
  claimables: new Map<string, ClaimableEntry>(),
  issuers: new Map<AccountAddress, { readonly authRequired: boolean }>(),
};

export const amount = (value: string) => Schema.decodeSync(Amount)(value);

export const accountState = (
  overrides: Partial<AccountState> = {},
): AccountState => ({
  sequence: "1000",
  ledger: 100,
  accountSponsored: true,
  sponsored: true,
  nativeBalance: 0n,
  balance: Option.some(amount("50000000")),
  ...overrides,
});

export const holdingsFor = (
  address: AccountAddress,
  overrides: Partial<Holdings> = {},
): Holdings => ({
  account: world.accounts.get(address) ?? accountState(),
  reserveSponsor: Option.none(),
  native: amount("0"),
  reserves: { subentries: 2, sponsored: 4, sponsoring: 0 },
  lines: [],
  ...overrides,
});

export const fakeChain = Layer.effect(
  Chain,
  Effect.gen(function* () {
    const real = yield* Chain;

    const rpcDown = () =>
      Effect.fail(new ChainUnreachable({ cause: new Error("RPC down") }));

    const account = (
      addr: AccountAddress,
    ): Effect.Effect<Option.Option<AccountState>, ChainUnreachable> =>
      world.ledgerDown
        ? rpcDown()
        : Effect.succeed(Option.fromNullishOr(world.accounts.get(addr)));

    const sourceOf = (addr: AccountAddress) =>
      new Account(addr, world.accounts.get(addr)?.sequence ?? "100");

    const draftWith = (
      build: (w: {
        readonly minTime: number;
        readonly maxTime: number;
      }) => SigningRequest["envelope"],
      offset = 0,
    ) =>
      Effect.map(Clock.currentTimeMillis, (ms) => {
        const minTime = Math.floor(ms / 1000) + offset;
        const maxTime = minTime + 120;

        return new SigningRequest({
          envelope: build({ minTime, maxTime }),
          expiresAt: DateTime.makeUnsafe(maxTime * 1000),
        });
      });

    return Chain.of({
      ...real,
      memoRequiredFor: (addr) =>
        world.ledgerDown
          ? rpcDown()
          : Effect.succeed(exchangeMemoFor(addr, world.exchangeMemos)),
      account,
      holdings: (addr, assets) =>
        world.holdings.has(addr)
          ? Effect.succeed(Option.fromNullishOr(world.holdings.get(addr)))
          : account(addr).pipe(
              Effect.map(
                Option.map((s) =>
                  holdingsFor(addr, {
                    account: s,
                    reserveSponsor: s.accountSponsored
                      ? Option.some(reserveSponsor)
                      : Option.none(),
                    native: amount(s.nativeBalance.toString()),
                    reserves: { subentries: 1, sponsored: 3, sponsoring: 0 },
                    lines: assets.flatMap((a) =>
                      a.code === baseAsset.code &&
                      a.issuer === baseAsset.issuer &&
                      Option.isSome(s.balance)
                        ? [
                            {
                              asset: a,
                              balance: s.balance.value,
                              spendable: s.balance.value,
                              capacity: amount("9223372036854775807"),
                              authorized: true,
                              clawbackEnabled: false,
                              sponsored: true,
                            },
                          ]
                        : [],
                    ),
                  }),
                ),
              ),
            ),
      claimable: (ids) =>
        world.claimablesDown
          ? rpcDown()
          : Effect.succeed(
              ids.flatMap((id) => {
                const e = world.claimables.get(id);

                return e ? [e] : [];
              }),
            ),
      issuer: (asset) =>
        Effect.succeed(
          Option.some(
            world.issuers.get(asset.issuer) ?? { authRequired: false },
          ),
        ),
      draftAsset: (addr, plan) =>
        draftWith((w) =>
          draftPlan(plan, { source: sourceOf(addr), reserveSponsor, ...w }),
        ),
      draftClaimable: (from, to, a, val) =>
        draftWith((w) =>
          draftClaimable({
            source: sourceOf(from),
            reserveSponsor,
            to,
            asset: a,
            amount: val,
            ...w,
          }),
        ),
      draftPaymentLink: (from, to, a, val) =>
        draftWith((w) =>
          draftPaymentLink({
            source: sourceOf(from),
            reserveSponsor,
            to,
            asset: a,
            amount: val,
            ...w,
          }),
        ),
      pastOpeningWindow: (s) =>
        Effect.map(
          Clock.currentTimeMillis,
          (now) => DateTime.toEpochMillis(s.expiresAt) < now,
        ),
      balance: (addr) =>
        account(addr).pipe(Effect.map(Option.flatMap((s) => s.balance))),
      draftOpening: (addr) =>
        draftWith((w) =>
          draftOpening({
            source: new Account(reserveSponsor, "100"),
            address: addr,
            createAccount: !world.accounts.has(addr),
            ...w,
          }),
        ),
      draftPayment: (from, to, a, val, memo) =>
        draftWith((w) =>
          draftPayment({
            source: sourceOf(from),
            to,
            asset: a,
            amount: val,
            memo,
            ...w,
          }),
        ),
      draftRecovery: (addr) =>
        draftWith(
          (w) =>
            draftRecovery({ source: sourceOf(addr), reserveSponsor, ...w }),
          60,
        ),
      submit: (sealed) =>
        Effect.gen(function* () {
          if (world.failSubmit) return yield* rpcDown();

          world.submitted.push(sealed);

          const outer = TransactionBuilder.fromXDR(
            sealed.envelope,
            networkPassphrase,
          );

          const first = (
            outer instanceof FeeBumpTransaction ? outer.innerTransaction : outer
          ).operations[0];

          if (first?.type === "beginSponsoringFutureReserves") {
            const addr = Schema.decodeSync(AccountAddress)(first.sponsoredId);

            world.accounts.set(
              addr,
              accountState({
                sequence: world.accounts.get(addr)?.sequence ?? "1000",
                balance: Option.some(amount("0")),
              }),
            );
          }
        }),
      settlement: (s) =>
        world.unreadable.has(s.hash)
          ? Effect.die(new Error("Malformed RPC reply"))
          : Effect.succeed(world.evidence.get(s.hash) ?? new Undecided()),
    });
  }),
).pipe(Layer.provide(realChain));

export const walletForDb = <E>(db: Layer.Layer<Database, E>) =>
  Wallet.serviceLayer.pipe(
    Layer.provide(storesFor(db)),
    Layer.provide(fakeChain),
    Layer.provide(settings),
  );

const walletLayer = walletForDb(dbLayer);
export const walletTestLayer = Layer.mergeAll(walletLayer, stores, dbLayer);

export const walletWithChain = (
  override: (a: Chain["Service"]) => Partial<Chain["Service"]>,
) =>
  Layer.fresh(
    Wallet.serviceLayer.pipe(
      Layer.provide(stores),
      Layer.provide(
        Layer.effect(
          Chain,
          Effect.map(Chain, (a) => Chain.of({ ...a, ...override(a) })),
        ).pipe(Layer.provide(fakeChain)),
      ),
      Layer.provide(settings),
    ),
  );

export const stellarWallet = (
  reply: (
    method: string,
    req: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) =>
  Layer.fresh(Wallet.serviceLayer).pipe(
    Layer.provide(Layer.fresh(Chain.layer)),
    Layer.provide(settingsFor(testRpcUrl)),
    Layer.provide(httpClientAnswering((req) => reply(rpcMethod(req), req))),
  );

export const stellarAnswering = (reply: (method: string) => string) =>
  stellarWallet((method) => Effect.succeed(jsonResponse(reply(method))));

export const timeOutRpc = <A, E, R>(
  started: Latch.Latch,
  run: Effect.Effect<A, E, R>,
) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const attempt = yield* Effect.forkChild(run);

        yield* started.await;
        yield* TestClock.adjust("10 seconds");

        return yield* Fiber.join(attempt);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

export const approve = (req: SigningRequest, key: Keypair) =>
  Option.some(
    new Approval({ signature: key.sign(signingPayload(req.envelope)) }),
  );

export const claimFor = (key: Keypair, name: string) =>
  new WalletClaim({
    address: addressOf(key),
    username: Schema.decodeSync(Username)(name),
  });

export const opening = (
  claim: WalletClaim,
  approval: Option.Option<Approval> = Option.none(),
) => Wallet.use((w) => w.open(claim, approval));

export const overviewOf = (addr: AccountAddress) =>
  Wallet.use((w) => w.overview(addr));

export const sweep = Wallet.use((w) => w.sweep);

export const findWallet = (addr: AccountAddress) =>
  Directory.use((d) => d.byAddress(addr));

export const findTransfer = (id: TransferId) =>
  Transfers.use((t) => t.find(id));

export const settleHash = (hash: string) =>
  world.evidence.set(hash, new Applied({ at: DateTime.nowUnsafe() }));

export const create = Effect.fn(function* (key: Keypair, name: string) {
  const claim = claimFor(key, name);
  const draft = yield* opening(claim);

  assertTagged(draft, "OpeningDraft");
  expect((yield* opening(claim, approve(draft.request, key)))._tag).toBe(
    "OpeningPending",
  );

  const recovery = yield* opening(claim);

  assertTagged(recovery, "RecoveryDraft");
  expect((yield* opening(claim, approve(recovery.request, key)))._tag).toBe(
    "Opened",
  );

  return claim;
});

export const fundHolder = (
  key: Keypair,
  overrides: Partial<AccountState> = {},
) => world.accounts.set(addressOf(key), accountState(overrides));

export const fundedWallet = Effect.fn(function* (
  name = "maria",
  overrides?: Partial<AccountState>,
) {
  const key = Keypair.random();

  yield* create(key, name);
  fundHolder(key, overrides);

  return key;
});

export const orderFor = (sender: Keypair, to: Recipient) =>
  new TransferOrder({
    asset: baseAsset,
    id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
    from: addressOf(sender),
    to,
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
  });

export const selfOrder = (sender: Keypair) =>
  orderFor(sender, AddressRecipient.make({ value: addressOf(sender) }));

export const send = (
  order: TransferOrder,
  approval: Option.Option<Approval> = Option.none(),
) => Wallet.use((w) => w.transfer(order, approval));

export const draftTransfer = Effect.fn(function* (order: TransferOrder) {
  const draft = yield* send(order);

  assertTagged(draft, "TransferDraft");

  return draft;
});

export const authorizeTransfer = Effect.fn(function* (
  sender: Keypair,
  order: TransferOrder,
  options: { readonly failSubmit?: boolean } = {},
) {
  const draft = yield* draftTransfer(order);

  world.failSubmit = options.failSubmit ?? false;
  yield* send(order, approve(draft.request, sender));
  world.failSubmit = false;

  const stored = Option.getOrThrow(yield* findTransfer(order.id));

  assertTagged(stored, "Authorized");

  return { draft, authorized: stored };
});

export const euro = IssuedAsset.make({
  code: Schema.decodeSync(AssetCode)("EUR"),
  issuer: addressOf(Keypair.random()),
});

export const euroLine = (
  balance: string,
  overrides: { readonly capacity?: Amount } = {},
) => ({
  asset: euro,
  balance: amount(balance),
  spendable: amount(balance),
  capacity: overrides.capacity ?? amount("9223372036854775807"),
  authorized: true,
  clawbackEnabled: false,
  sponsored: true,
});

export const devicePasskeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;

export const openSender = Effect.fn(function* (
  store: KeyStore,
  name = "maria",
) {
  const sender = new DeviceWallet({
    ...enrolledDeviceWallet(name),
    reserveSponsor,
  });

  yield* create(signingKey(sender.phrase), name);
  yield* store.write(sender);
  world.accounts.set(sender.address, accountState());

  return { wallet: yield* Wallet, sender };
});

export const settleOnSubmit =
  (wallet: WalletPort, sender: AccountAddress): WalletPort["transfer"] =>
  (order, approval) =>
    wallet.transfer(order, approval).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sealed = world.submitted.at(-1);

          if (Option.isNone(approval) || !sealed) return;

          settleHash(sealed.hash);

          const outer = TransactionBuilder.fromXDR(
            sealed.envelope,
            networkPassphrase,
          );

          const inner =
            outer instanceof FeeBumpTransaction
              ? outer.innerTransaction
              : outer;

          if (
            inner.operations[1]?.type === "createClaimableBalance" &&
            Predicate.isTagged(order.to, "PaymentLink")
          ) {
            const balance = Schema.decodeSync(BalanceId)(
              inner.getClaimableBalanceId(1),
            );

            world.claimables.set(balance, {
              balance,
              asset: order.asset,
              amount: order.amount,
              sponsored: true,
              claimants: [
                new Claimant(order.to.value, Claimant.predicateUnconditional()),
                new Claimant(sender, Claimant.predicateUnconditional()),
              ],
            });
          }
        }),
      ),
    );

export function useDisposableDatabase() {
  beforeAll(async () => {
    await Effect.runPromise(
      Database.use((db) =>
        migrate(db, { migrationsFolder: `${import.meta.dirname}/../drizzle` }),
      ).pipe(Effect.provide(dbLayer)),
    );
  });

  beforeEach(async () => {
    world.accounts.clear();
    world.holdings.clear();
    world.claimables.clear();
    world.issuers.clear();
    world.evidence.clear();
    world.submitted.length = 0;
    world.exchangeMemos.length = 0;
    world.failSubmit = false;
    world.ledgerDown = false;
    world.unreadable.clear();
    world.claimablesDown = false;
    await Effect.runPromise(
      Database.use((db) =>
        db.execute(
          sql`truncate asset_orders, trustlines, transfers, usernames, wallets, backups, passkey_challenges`,
        ),
      ).pipe(Effect.provide(dbLayer)),
    );
  });
}
