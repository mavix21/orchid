import { assertTagged } from "./tagged";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import { AssetOrders, AssetProposed } from "../src/server/AssetOrders.server";
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
import { epochAt, network } from "../src/stellar/network";
import {
  addressOf,
  approve,
  create,
  fakeChain,
  fundHolder,
  orderFor,
  runAcrossLockWait,
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
      "overview shares one concurrency budget of four across holdings and claimables",
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

          const RecipientJson = Schema.fromJsonString(ResolvedRecipient);

          const ownerProfile = new Profile({
            address: owner,
            username: claim.username,
          });

          const settledTransfers: ReadonlyArray<typeof transfers.$inferInsert> =
            [0, 1, 2, 3].map((index) => {
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
                status: "settled",
                envelope: "envelope",
                hash: "0".repeat(64),
                expiresAt: new Date(now + 60_000),
                concludedAt: new Date(now),
                balanceId: Schema.decodeSync(BalanceId)(
                  `00000000${index.toString(16).padStart(2, "0")}${"a".repeat(62)}`,
                ),
              };
            });

          yield* db.insert(transfers).values([...settledTransfers]);

          const transientBalance = Schema.decodeSync(BalanceId)(
            `0000000000${"a".repeat(62)}`,
          );

          world.claimables.set(transientBalance, {
            balance: transientBalance,
            asset,
            amount: Schema.decodeSync(PositiveAmount)("10000000"),
            sponsored: true,
            claimants: [new Claimant(owner, Claimant.predicateUnconditional())],
          });

          const claimableStarted = yield* Latch.make();
          const releaseInitialClaimable = yield* Latch.make();
          const initialClaimableDone = yield* Latch.make();
          const reachedFour = yield* Latch.make();
          const releaseConfirms = yield* Latch.make();
          let inFlight = 0;
          let maxInFlight = 0;

          const trackRead = <A, E>(
            gate: Latch.Latch,
            run: Effect.Effect<A, E>,
            onStart: Effect.Effect<void> = Effect.void,
            onEnd: Effect.Effect<void> = Effect.void,
          ) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                inFlight += 1;

                if (inFlight > maxInFlight) maxInFlight = inFlight;

                yield* onStart;

                if (inFlight >= 4) yield* reachedFour.open;
              }),
              () => gate.await.pipe(Effect.andThen(run)),
              () =>
                Effect.sync(() => {
                  inFlight -= 1;
                }).pipe(Effect.andThen(onEnd)),
            );

          const concurrentChain = Layer.effect(
            Chain,
            Effect.gen(function* () {
              const actual = yield* Chain;

              return Chain.of({
                ...actual,
                holdings: (address, assets) =>
                  trackRead(
                    assets.length > 1 ? claimableStarted : releaseConfirms,
                    actual.holdings(address, assets),
                  ),
                claimable: (balances) =>
                  balances.length > 1
                    ? trackRead(
                        releaseInitialClaimable,
                        actual.claimable(
                          balances.filter((id) => id !== transientBalance),
                        ),
                        claimableStarted.open,
                        initialClaimableDone.open,
                      )
                    : trackRead(releaseConfirms, actual.claimable(balances)),
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

          const yieldTurns = Effect.repeat(Effect.yieldNow, { times: 3 });

          const overview = yield* Effect.gen(function* () {
            expect(
              Option.isSome(
                yield* reachedFour.await.pipe(
                  Effect.timeoutOption("2 seconds"),
                ),
              ),
            ).toBe(true);
            yield* yieldTurns;
            yield* releaseInitialClaimable.open;
            expect(
              Option.isSome(
                yield* initialClaimableDone.await.pipe(
                  Effect.timeoutOption("2 seconds"),
                ),
              ),
            ).toBe(true);
            yield* yieldTurns;
            yield* releaseConfirms.open;

            return yield* Fiber.join(fiber);
          }).pipe(
            Effect.ensuring(
              claimableStarted.open.pipe(
                Effect.andThen(releaseInitialClaimable.open),
                Effect.andThen(releaseConfirms.open),
              ),
            ),
          );

          assertTagged(overview, "Holding");

          expect(maxInFlight).toBe(4);
          expect(
            yield* AssetOrders.use((service) => service.tracked(owner)),
          ).toEqual([]);
          expect(
            (yield* Transfers.use((service) =>
              service.openBalances(owner),
            )).map((item) => item.balance),
          ).toEqual([transientBalance]);
          expect(overview.balances).toHaveLength(1);
          expect(overview.claimable).toEqual([]);
        }),
    );

    const lockCases: ReadonlyArray<{
      readonly name: string;
      readonly locktype: "advisory" | "relation";
      readonly lock: (
        address: ReturnType<typeof addressOf>,
      ) => ReturnType<typeof walletLock>;
    }> = [
      {
        name: "the wallet advisory lock",
        locktype: "advisory",
        lock: walletLock,
      },
      {
        name: "the post-lock slot query",
        locktype: "relation",
        lock: () => sql`lock table transfers in access exclusive mode`,
      },
    ];

    it.effect.each(lockCases)(
      "asset authorization keeps an order proposed when waiting on $name crosses the approval margin",
      ({ locktype, lock }) =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "assetlockowner");
          fundHolder(key);

          const opening = order(key, OpenTrustline.make({ asset }));

          assertTagged(yield* manage(opening), "AssetDraft");

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

          const { result: outcome } = yield* runAcrossLockWait({
            locktype,
            advance: "101 seconds",
            acquire: (tx) => tx.execute(lock(addressOf(key))),
            run: AssetOrders.use((service) =>
              service.authorize(stored, sealed),
            ),
          });

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
