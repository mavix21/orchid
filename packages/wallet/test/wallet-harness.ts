import { beforeAll, beforeEach, expect } from "@effect/vitest";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressRecipient,
  type CheckedRecipient,
  Amount,
  Approval,
  type Approvals,
  type AssetId,
  HumanCheckRefused,
  OpeningDraft,
  PositiveAmount,
  type Recipient,
  SigningRequest,
  TransferId,
  TransferIntent,
  TransferOrder,
  Username,
  WalletClaim,
  baseAsset,
  sameAsset,
} from "../src/contract";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import {
  Applied,
  Chain,
  ChainUnreachable,
  type Sealed,
  type Settlement,
  Undecided,
} from "../src/server/Chain.server";
import { accountChain } from "../src/server/chain-accounts.server";
import { destinationChain } from "../src/server/chain-destinations.server";
import { draftChain } from "../src/server/chain-drafts.server";
import { linkChain } from "../src/server/chain-links.server";
import { Deposits } from "../src/server/Deposits.server";
import { Directory } from "../src/server/Directory.server";
import { HumanCheck } from "../src/server/HumanCheck.server";
import { checkedBinding } from "../src/server/username-standing.server";
import { transfers } from "../src/server/tables.server";
import {
  type KnownExchangeMemo,
  exchangeMemoFor,
} from "../src/stellar/exchange-memos.server";
import {
  type ClaimableBalance,
  unclaimedFundsEntry,
} from "../src/stellar/ledger-assets.server";
import type { Holdings } from "../src/server/holdings.server";
import type { AccountState } from "../src/stellar/ledger.server";
import {
  type PendingWork,
  QueueUnavailable,
  WorkQueue,
} from "../src/server/work-queue.server";
import { RateLimits } from "../src/server/RateLimits.server";
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
  signingPayload,
} from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import {
  DeviceWallet,
  type MemoryKeyStore,
  addressOf,
  enrolledDeviceWallet,
  signingKey,
} from "./device-fixtures";
import { ledgersHttp, resetLedgers } from "./rpc-events";
import { SoftwareAuthenticator } from "./software-authenticator";
import {
  channel,
  feePayer,
  passkeyOrigin,
  reserveSponsor,
  settingsFor,
  sponsor,
} from "./wallet-settings";
import { assertTagged } from "./tagged";
import { dbLayer } from "./test-database";

export { addressOf };

export { euro, euroLine } from "./euro-fixtures";

export { dbLayer };

export const world = {
  humanCheckRefused: false,
  accounts: new Map<AccountAddress, AccountState>(),
  evidence: new Map<string, Settlement>(),
  submitted: new Array<Sealed>(),
  queued: new Array<PendingWork>(),
  queueDown: false,
  unmergeable: new Set<AccountAddress>(),
  exchangeMemos: new Array<KnownExchangeMemo>(),
  failSubmit: false,
  ledgerDown: false,
  unreadable: new Set<string>(),
  claimablesDown: false,
  holdings: new Map<AccountAddress, Holdings>(),
  claimables: new Map<string, ClaimableBalance>(),
  issuers: new Map<AssetId, { readonly authRequired: boolean }>(),
};

const recordingQueue = Layer.succeed(WorkQueue, {
  send: (work) =>
    world.queueDown
      ? Effect.fail(new QueueUnavailable({ cause: new Error("Queue down") }))
      : Effect.sync(() => {
          world.queued.push(work);
        }),
});

const storesFor = <E>(db: Layer.Layer<Database, E>) =>
  Layer.mergeAll(
    Directory.layer,
    Transfers.layer,
    AssetOrders.layer,
    Backups.layer,
    Deposits.layer,
  ).pipe(Layer.provide(db), Layer.provide(recordingQueue));

export const stores = storesFor(dbLayer);

export {
  channel,
  feePayer,
  passkeyOrigin,
  reserveSponsor,
  settingsFor,
  sponsor,
};

const settings = settingsFor();

const realChain = Chain.layer.pipe(
  Layer.provide(settings),
  Layer.provide(ledgersHttp),
  Layer.provide(dbLayer),
);

export const amount = (value: string) => Schema.decodeSync(Amount)(value);

export const accountState = (
  overrides: Partial<AccountState> = {},
): AccountState => ({
  sequence: "1000",
  ledger: 100,
  accountSponsored: true,
  sponsored: true,
  untouched: true,
  nativeBalance: 0n,
  balance: Option.some(amount("50000000")),
  ...overrides,
});

export const holdingsFor = (
  address: AccountAddress,
  overrides: Partial<Holdings> = {},
): Holdings => ({
  nativeTotal: amount(
    (world.accounts.get(address) ?? accountState()).nativeBalance.toString(),
  ),
  reserveSponsor: Option.none(),
  native: amount("0"),
  trustlineSlotsUsed: 2,
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

    const holdings: Chain["Service"]["holdings"] = (addr, assets) =>
      world.holdings.has(addr)
        ? Effect.succeed(Option.fromNullishOr(world.holdings.get(addr)))
        : account(addr).pipe(
            Effect.map(
              Option.map((s) =>
                holdingsFor(addr, {
                  nativeTotal: amount(s.nativeBalance.toString()),
                  reserveSponsor: s.accountSponsored
                    ? Option.some(reserveSponsor)
                    : Option.none(),
                  native: amount(s.nativeBalance.toString()),
                  trustlineSlotsUsed: 1,
                  lines: assets.flatMap((a) =>
                    sameAsset(a, baseAsset) && Option.isSome(s.balance)
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
          );

    const links = linkChain(
      sponsor,
      feePayer,
      account,
      () => Effect.sync(() => sourceOf(channel)),
      () => Effect.void,
    );

    return Chain.of({
      ...real,
      ...accountChain(account),
      ...destinationChain(holdings, (addr) =>
        world.ledgerDown
          ? rpcDown()
          : Effect.succeed(exchangeMemoFor(addr, world.exchangeMemos)),
      ),
      ...draftChain(account),
      ...links,
      holdings,
      unclaimedFunds: (ids) =>
        world.claimablesDown
          ? rpcDown()
          : Effect.succeed(
              ids.flatMap((id) => {
                const e = world.claimables.get(id);

                return e ? [unclaimedFundsEntry(e)] : [];
              }),
            ),
      issuer: (asset) =>
        Effect.succeed(
          Option.some(world.issuers.get(asset.id) ?? { authRequired: false }),
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
      cleanUpLink: (link) =>
        Effect.sync(
          () => !world.unmergeable.has(link) && !world.accounts.delete(link),
        ),
      pastOpeningWindow: (s) =>
        Effect.map(
          Clock.currentTimeMillis,
          (now) => DateTime.toEpochMillis(s.expiresAt) < now,
        ),
      draftOpening: (addr, claim) =>
        draftWith((w) =>
          draftOpening({
            channel: sourceOf(channel),
            reserveSponsor,
            address: addr,
            createAccount: !world.accounts.has(addr),
            claim,
            ...w,
          }),
        ).pipe(Effect.map((request) => new OpeningDraft({ request }))),
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
      submit: (sealed) =>
        Effect.gen(function* () {
          if (world.failSubmit) return yield* rpcDown();

          world.submitted.push(sealed);

          const outer = TransactionBuilder.fromXDR(
            sealed.envelope,
            networkPassphrase,
          );

          const inner =
            outer instanceof FeeBumpTransaction
              ? outer.innerTransaction
              : outer;

          const [first] = inner.operations;

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

export const bindingAllowed = checkedBinding(
  Effect.succeed(Option.none<HumanCheckRefused>()),
);

export const fakeHumanCheck = Layer.succeed(
  HumanCheck,
  HumanCheck.of({
    verify: () =>
      Effect.succeed(
        world.humanCheckRefused
          ? Option.some(new HumanCheckRefused())
          : Option.none(),
      ),
  }),
);

export const walletForDb = <E>(
  db: Layer.Layer<Database, E>,
  limits: Layer.Layer<RateLimits> = RateLimits.unlimited,
) =>
  Wallet.serviceLayer.pipe(
    Layer.provide(storesFor(db)),
    Layer.provide(limits),
    Layer.provide(fakeChain),
    Layer.provide(fakeHumanCheck),
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
      Layer.provide(RateLimits.unlimited),
      Layer.provide(
        Layer.effect(
          Chain,
          Effect.map(Chain, (a) => Chain.of({ ...a, ...override(a) })),
        ).pipe(Layer.provide(fakeChain)),
      ),
      Layer.provide(fakeHumanCheck),
      Layer.provide(settings),
    ),
  );

export const approve = (req: SigningRequest, key: Keypair) =>
  Option.some(
    new Approval({ signature: key.sign(signingPayload(req.envelope)) }),
  );

export const approveOpening = (
  key: Keypair,
  draft: OpeningDraft,
): Option.Option<Approvals> =>
  Option.some([
    new Approval({
      signature: key.sign(signingPayload(draft.request.envelope)),
    }),
  ]);

export const claimFor = (key: Keypair, name: string) =>
  new WalletClaim({
    address: addressOf(key),
    username: Schema.decodeSync(Username)(name),
  });

export const opening = (
  claim: WalletClaim,
  approvals: Option.Option<Approvals> = Option.none(),
) => Wallet.use((w) => w.open(claim, approvals));

export const overviewOf = (addr: AccountAddress) =>
  Wallet.use((w) => w.overview(addr));

export const sweepNow = Wallet.use((w) => w.sweep);

export const attend = (work: PendingWork, attempt = 1) =>
  Wallet.use((w) => w.attend(work, attempt));

export const ageSignedWork = Database.use((db) =>
  Effect.all([
    db.execute(
      sql`update transfers set "expiresAt" = "expiresAt" - interval '1 hour' where status = 'authorized'`,
    ),
    db.execute(
      sql`update asset_orders set "expiresAt" = "expiresAt" - interval '1 hour' where status = 'authorized'`,
    ),
    db.execute(
      sql`update asset_orders set "concludedAt" = "concludedAt" - interval '1 hour' where status = 'settled' and "linkCleanedAt" is null`,
    ),
  ]),
);

export const sweep = ageSignedWork.pipe(Effect.andThen(sweepNow));

export const authorizedTransfers = Database.use((db) =>
  db
    .select({ id: transfers.id, envelope: transfers.envelope })
    .from(transfers)
    .where(eq(transfers.status, "authorized")),
);

export const findWallet = (addr: AccountAddress) =>
  Directory.use((d) => d.byAddress(addr));

export const findTransfer = (id: TransferId) =>
  Transfers.use((t) => t.find(id));

export const settleHash = (hash: string) =>
  world.evidence.set(hash, new Applied({ at: DateTime.nowUnsafe() }));

export const settleAttempt = Effect.fn(function* (
  address: AccountAddress,
  settledSecondsAgo = 0,
) {
  const row = Option.getOrThrow(yield* findWallet(address));

  world.evidence.set(
    Option.getOrThrow(Option.fromNullishOr(row.attemptHash)),
    new Applied({
      at: DateTime.makeUnsafe(Date.now() - settledSecondsAgo * 1000),
    }),
  );
});

export const create = Effect.fn(function* (key: Keypair, name: string) {
  const claim = claimFor(key, name);
  const draft = yield* opening(claim);

  assertTagged(draft, "OpeningDraft");
  expect((yield* opening(claim, approveOpening(key, draft)))._tag).toBe(
    "OpeningPending",
  );
  yield* settleAttempt(claim.address);
  expect((yield* opening(claim))._tag).toBe("Opened");

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

export const checkRecipient = (to: CheckedRecipient) =>
  Wallet.use((w) => w.checkRecipient(to));

export const assess = (sender: Keypair, order: TransferOrder) =>
  Wallet.use((w) =>
    w.assess(
      addressOf(sender),
      new TransferIntent({
        to: order.to,
        asset: order.asset,
        amount: order.amount,
        memo: order.memo,
      }),
    ),
  );

export const storedTransfers = (address: AccountAddress) =>
  Database.use((db) =>
    db
      .select({ id: transfers.id })
      .from(transfers)
      .where(eq(transfers.sender, address)),
  );

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

export const devicePasskeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;

export const openSender = Effect.fn(function* (
  store: MemoryKeyStore,
  name = "maria",
) {
  const sender = new DeviceWallet({
    ...enrolledDeviceWallet(name),
    reserveSponsor,
  });

  yield* create(signingKey(sender.phrase), name);
  yield* store.seed(sender);
  world.accounts.set(sender.address, accountState());

  return { wallet: yield* Wallet, sender };
});

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
    world.queued.length = 0;
    world.queueDown = false;
    world.unmergeable.clear();
    world.exchangeMemos.length = 0;
    world.failSubmit = false;
    world.humanCheckRefused = false;
    world.ledgerDown = false;
    world.unreadable.clear();
    world.claimablesDown = false;
    resetLedgers();
    await Effect.runPromise(
      Database.use((db) =>
        db.execute(
          sql`truncate asset_orders, trustlines, transfers, usernames, wallets, backups, passkey_challenges, deposits, deposit_cursors, channel_leases`,
        ),
      ).pipe(Effect.provide(dbLayer)),
    );
  });
}
