import { assertTagged } from "./tagged";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { AssetOrders, AssetProposed } from "../src/server/AssetOrders.server";
import { rpcReadConcurrency } from "../src/server/settings.server";
import { walletLock } from "../src/server/slot.server";
import { transfers, trustlines } from "../src/server/tables.server";
import { OrderJson, Transfers } from "../src/server/Transfers.server";
import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  BalanceId,
  Profile,
  ResolvedRecipient,
  TransferOrder,
  Username,
  NativeAsset,
  Pending,
  Amount,
  AssetCode,
  AssetOrder,
  AssetOrderId,
  AssetDraft,
  AssetPending,
  AssetSettled,
  AssetBusy,
  ClaimBalance,
  IssuedAsset,
  OpenTrustline,
  CloseTrustline,
  TrustlineLimitReached,
  TrustlineNotEmpty,
  UsernameRecipient,
  TransferDraft,
  PositiveAmount,
} from "../src/contract";
import { Wallet } from "../src/server/Wallet.server";
import { Applied, Chain } from "../src/server/Chain.server";
import { ClaimFacts, TrustlineFacts } from "../src/stellar/asset-envelopes";
import { readEnvelope } from "../src/stellar/envelopes";
import {
  approvalMargin,
  epochAt,
  network,
  paymentLifetime,
} from "../src/stellar/network";
import {
  addressOf,
  approve,
  create,
  fakeChain,
  fundHolder,
  orderFor,
  send,
  settings,
  stores,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const asset = IssuedAsset.make({
  code: Schema.decodeSync(AssetCode)("EUR"),
  issuer: addressOf(Keypair.random()),
});

const manage = (
  order: AssetOrder,
  approval = Option.none<import("../src/contract").Approval>(),
) => Wallet.use((wallet) => wallet.manage(order, approval));

const order = (key: Keypair, action: AssetOrder["action"]) =>
  new AssetOrder({
    id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
    wallet: addressOf(key),
    action,
  });

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "sponsored trustline approval survives submit failure and sweep records settlement",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "assetowner");
          fundHolder(key);

          const opening = order(key, OpenTrustline.make({ asset }));
          const draft = yield* manage(opening);

          expect(draft).toBeInstanceOf(AssetDraft);

          assertTagged(draft, "AssetDraft");

          expect(
            Option.getOrThrow(readEnvelope(draft.request.envelope)),
          ).toBeInstanceOf(TrustlineFacts);
          world.failSubmit = true;
          expect(
            yield* manage(opening, approve(draft.request, key)),
          ).toBeInstanceOf(AssetPending);

          const competing = order(key, OpenTrustline.make({ asset }));

          expect(yield* manage(competing)).toBeInstanceOf(AssetBusy);
          world.failSubmit = false;
          yield* Wallet.use((wallet) => wallet.sweep);

          const submitted = world.submitted.at(-1);

          if (!submitted) throw new Error("Expected submission");

          world.evidence.set(
            submitted.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(yield* manage(opening)).toBeInstanceOf(AssetSettled);
        }),
    );

    it.effect(
      "ledger reserve cap and nonzero trustline prevent new sponsored entries and removal",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "limitowner");
          fundHolder(key);

          const account = world.accounts.get(addressOf(key));

          if (!account) throw new Error("Missing account");

          world.holdings.set(addressOf(key), {
            account,
            reserveSponsor: Option.none(),
            native: Schema.decodeSync(Amount)("0"),
            reserves: { subentries: 6, sponsored: 8, sponsoring: 0 },
            lines: [],
          });
          expect(
            yield* manage(order(key, OpenTrustline.make({ asset }))),
          ).toBeInstanceOf(TrustlineLimitReached);
          world.holdings.set(addressOf(key), {
            account,
            reserveSponsor: Option.none(),
            native: Schema.decodeSync(Amount)("0"),
            reserves: { subentries: 2, sponsored: 4, sponsoring: 0 },
            lines: [
              {
                asset,
                balance: Schema.decodeSync(Amount)("1"),
                spendable: Schema.decodeSync(Amount)("1"),
                authorized: true,
                sponsored: true,
              },
            ],
          });
          expect(
            yield* manage(order(key, CloseTrustline.make({ asset }))),
          ).toBeInstanceOf(TrustlineNotEmpty);
        }),
    );

    it.effect(
      "missing recipient trustline uses a sponsored claimable and claim opens the line atomically",
      () =>
        Effect.gen(function* () {
          const sender = Keypair.random();
          const recipient = Keypair.random();

          yield* create(sender, "assetsender");
          yield* create(recipient, "assetrecipient");
          fundHolder(sender);
          fundHolder(recipient);

          const account = world.accounts.get(addressOf(sender));

          if (!account) throw new Error("Missing account");

          world.holdings.set(addressOf(sender), {
            account,
            reserveSponsor: Option.none(),
            native: Schema.decodeSync(Amount)("0"),
            reserves: { subentries: 2, sponsored: 4, sponsoring: 0 },
            lines: [
              {
                asset,
                balance: Schema.decodeSync(Amount)("50000000"),
                spendable: Schema.decodeSync(Amount)("50000000"),
                authorized: true,
                sponsored: true,
              },
            ],
          });

          const payment = new TransferOrder({
            ...orderFor(
              sender,
              UsernameRecipient.make({
                value: Schema.decodeSync(Username)("assetrecipient"),
              }),
            ),
            asset,
          });

          const draft = yield* send(payment);

          assertTagged(draft, "TransferDraft");

          const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

          assertTagged(facts, "ClaimableFacts");

          expect(
            yield* send(payment, approve(draft.request, sender)),
          ).toBeInstanceOf(Pending);
          yield* Wallet.use((wallet) => wallet.sweep);
          expect(
            yield* Transfers.use((service) =>
              service.openClaimables(addressOf(sender)),
            ),
          ).toBe(1);

          world.claimables.set(facts.balance, {
            balance: facts.balance,
            asset,
            amount: Schema.decodeSync(PositiveAmount)("10000000"),
            sponsored: true,
            claimants: [
              new Claimant(
                addressOf(recipient),
                Claimant.predicateUnconditional(),
              ),
            ],
          });

          const claim = yield* manage(
            order(recipient, ClaimBalance.make({ balance: facts.balance })),
          );

          assertTagged(claim, "AssetDraft");

          const claimed = Option.getOrThrow(
            readEnvelope(claim.request.envelope),
          );

          expect(claimed).toBeInstanceOf(ClaimFacts);

          assertTagged(claimed, "ClaimFacts");

          expect(claimed.opens).toEqual(asset);

          const claimOrder = order(
            recipient,
            ClaimBalance.make({ balance: facts.balance }),
          );

          const claimDraft = yield* manage(claimOrder);

          assertTagged(claimDraft, "AssetDraft");

          expect(
            yield* manage(claimOrder, approve(claimDraft.request, recipient)),
          ).toBeInstanceOf(AssetPending);
        }),
    );

    it.effect(
      "native sends spend only available XLM and empty trustline removal stays holder signed",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "nativeowner");
          fundHolder(key);

          const account = world.accounts.get(addressOf(key));

          if (!account) throw new Error("Missing account");

          world.holdings.set(addressOf(key), {
            account,
            reserveSponsor: Option.none(),
            native: Schema.decodeSync(Amount)("50000000"),
            reserves: { subentries: 2, sponsored: 4, sponsoring: 0 },
            lines: [
              {
                asset,
                balance: Schema.decodeSync(Amount)("0"),
                spendable: Schema.decodeSync(Amount)("0"),
                authorized: true,
                sponsored: true,
              },
            ],
          });

          const native = new TransferOrder({
            ...orderFor(
              key,
              UsernameRecipient.make({
                value: Schema.decodeSync(Username)("nativeowner"),
              }),
            ),
            asset: NativeAsset.make({}),
          });

          const draft = yield* send(native);

          expect(draft).toBeInstanceOf(TransferDraft);

          assertTagged(draft, "TransferDraft");

          const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

          expect(facts).toMatchObject({ asset: NativeAsset.make({}) });

          const close = order(key, CloseTrustline.make({ asset }));
          const removal = yield* manage(close);

          assertTagged(removal, "AssetDraft");

          expect(
            yield* manage(close, approve(removal.request, key)),
          ).toBeInstanceOf(AssetPending);
        }),
    );

    it.effect(
      "overview shares one concurrency budget of four across holdings and claimables missing confirmations",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = yield* create(key, "concurrentowner");

          fundHolder(key);

          const db = yield* Database;
          const now = yield* Clock.currentTimeMillis;
          const epoch = epochAt(now);
          const owner = addressOf(key);

          const missingAssets = ["EUR", "GBP", "JPY", "BRL"].map((code) =>
            IssuedAsset.make({
              code: Schema.decodeSync(AssetCode)(code),
              issuer: addressOf(Keypair.random()),
            }),
          );

          yield* db.insert(trustlines).values(
            missingAssets.map((tracked) => ({
              address: owner,
              network,
              testnetEpoch: epoch,
              code: tracked.code,
              issuer: tracked.issuer,
            })),
          );

          const ownerProfile = new Profile({
            address: owner,
            username: claim.username,
          });

          const RecipientJson = Schema.fromJsonString(ResolvedRecipient);

          const missingBalances = [0, 1, 2, 3].map((index) =>
            Schema.decodeSync(BalanceId)(
              `00000000${index.toString(16).padStart(2, "0")}${"a".repeat(62)}`,
            ),
          );

          yield* db.insert(transfers).values(
            missingBalances.map((balanceId) => {
              const transferOrder = orderFor(
                key,
                UsernameRecipient.make({ value: claim.username }),
              );

              return {
                id: transferOrder.id,
                sender: owner,
                recipient: owner,
                destination: owner,
                order: Schema.encodeSync(OrderJson)(transferOrder),
                resolvedRecipient:
                  Schema.encodeSync(RecipientJson)(ownerProfile),
                amount: transferOrder.amount,
                network,
                testnetEpoch: epoch,
                status: "settled" as const,
                envelope: "envelope",
                hash: "0".repeat(64),
                expiresAt: new Date(now + 60_000),
                concludedAt: new Date(now),
                balanceId,
              };
            }),
          );

          const holdingsStarted = yield* Latch.make();
          const claimableStarted = yield* Latch.make();
          const reachedBound = yield* Latch.make();
          const releaseConfirms = yield* Latch.make();
          let inFlight = 0;
          let maxInFlight = 0;
          let holdingsConfirms = 0;
          let claimableConfirms = 0;

          const trackConfirm = <A, E>(
            kind: "holdings" | "claimable",
            run: Effect.Effect<A, E>,
          ) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                inFlight += 1;

                if (inFlight > maxInFlight) maxInFlight = inFlight;

                if (kind === "holdings") holdingsConfirms += 1;
                else claimableConfirms += 1;

                if (inFlight >= rpcReadConcurrency) yield* reachedBound.open;

                yield* releaseConfirms.await;
              }),
              () => run,
              () =>
                Effect.sync(() => {
                  inFlight -= 1;
                }),
            );

          const concurrentChain = Layer.effect(
            Chain,
            Effect.gen(function* () {
              const actual = yield* Chain;

              return Chain.of({
                ...actual,
                holdings: (address, assets) =>
                  assets.length > 1
                    ? holdingsStarted.open.pipe(
                        Effect.andThen(claimableStarted.await),
                        Effect.andThen(actual.holdings(address, assets)),
                      )
                    : trackConfirm(
                        "holdings",
                        actual.holdings(address, assets),
                      ),
                claimable: (balances) =>
                  balances.length > 1
                    ? claimableStarted.open.pipe(
                        Effect.andThen(holdingsStarted.await),
                        Effect.andThen(actual.claimable(balances)),
                      )
                    : trackConfirm("claimable", actual.claimable(balances)),
              });
            }),
          ).pipe(Layer.provide(fakeChain));

          const concurrentWallet = Wallet.serviceLayer.pipe(
            Layer.provide(stores),
            Layer.provide(concurrentChain),
            Layer.provide(settings),
          );

          const fiber = yield* Wallet.use((wallet) =>
            wallet.overview(owner),
          ).pipe(
            Effect.provide(Layer.fresh(concurrentWallet)),
            Effect.forkChild,
          );

          yield* reachedBound.await;
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* releaseConfirms.open;

          const overview = yield* Fiber.join(fiber);

          assertTagged(overview, "Holding");

          expect(maxInFlight).toBe(rpcReadConcurrency);
          expect(holdingsConfirms).toBe(missingAssets.length);
          expect(claimableConfirms).toBe(missingBalances.length);
          expect(
            yield* AssetOrders.use((service) => service.tracked(owner)),
          ).toEqual([]);
          expect(
            yield* Transfers.use((service) => service.openBalances(owner)),
          ).toEqual([]);
          expect(overview.balances).toHaveLength(1);
          expect(overview.claimable).toEqual([]);
        }),
    );

    it.effect(
      "asset authorization keeps an order proposed when waiting on the wallet lock crosses the approval margin",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "assetlockowner");
          fundHolder(key);

          const opening = order(key, OpenTrustline.make({ asset }));
          const draft = yield* manage(opening);

          assertTagged(draft, "AssetDraft");

          const stored = Option.getOrThrow(
            yield* AssetOrders.use((service) => service.find(opening.id)),
          );

          assertTagged(stored, "AssetProposed");

          const sealed = yield* Chain.use((chain) =>
            chain.seal(
              stored.request,
              Option.getOrThrow(approve(stored.request, key)),
              addressOf(key),
            ),
          ).pipe(Effect.provide(fakeChain));

          const db = yield* Database;
          const now = yield* Clock.currentTimeMillis;

          const outcome = yield* Effect.gen(function* () {
            yield* TestClock.setTime(now);

            const lockHeld = yield* Latch.make();
            const releaseLock = yield* Latch.make();

            const holder = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx.execute(walletLock(addressOf(key)));
                  yield* lockHeld.open;
                  yield* releaseLock.await;
                }),
              )
              .pipe(Effect.forkChild);

            yield* lockHeld.await;

            const attempt = yield* AssetOrders.use((service) =>
              service.authorize(stored, sealed),
            ).pipe(Effect.forkChild);

            while (
              (yield* db.execute(
                sql`select 1 from pg_locks where locktype = 'advisory' and not granted`,
              )).rows.length === 0
            )
              yield* Effect.yieldNow;

            yield* TestClock.adjust(
              Duration.seconds(paymentLifetime - approvalMargin + 1),
            );
            yield* releaseLock.open;
            yield* Fiber.join(holder);

            return yield* Fiber.join(attempt);
          }).pipe(Effect.provide(TestClock.layer()));

          expect(outcome).toBeInstanceOf(AssetProposed);
          expect(
            Option.getOrThrow(
              yield* AssetOrders.use((service) => service.find(opening.id)),
            ),
          ).toBeInstanceOf(AssetProposed);
        }),
    );
  },
);
