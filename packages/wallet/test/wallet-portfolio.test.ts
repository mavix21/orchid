import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssetCode,
  BalanceId,
  IssuedAsset,
  Profile,
  ResolvedRecipient,
  UsernameRecipient,
} from "../src/contract";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Chain } from "../src/server/Chain.server";
import { transfers, trustlines } from "../src/server/tables.server";
import { OrderJson, Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { epochAt, network } from "../src/stellar/network";
import { assertTagged } from "./tagged";
import {
  addressOf,
  create,
  fakeChain,
  fundHolder,
  orderFor,
  settings,
  stores,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
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

          const settledTransfers: ReadonlyArray<typeof transfers.$inferInsert> =
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
                status: "settled",
                envelope: "envelope",
                hash: "0".repeat(64),
                expiresAt: new Date(now + 60_000),
                concludedAt: new Date(now),
                balanceId,
              };
            });

          yield* db.insert(transfers).values([...settledTransfers]);

          const claimableStarted = yield* Latch.make();
          const releaseInitialClaimable = yield* Latch.make();
          const initialClaimableDone = yield* Latch.make();
          const reachedFour = yield* Latch.make();
          const releaseConfirms = yield* Latch.make();
          let inFlight = 0;
          let maxInFlight = 0;
          let initialReads = 0;
          let holdingsConfirms = 0;
          let claimableConfirms = 0;

          const trackRead = <A, E>(
            gate: Latch.Latch | undefined,
            run: Effect.Effect<A, E>,
            onStart: () => Effect.Effect<void>,
            onEnd: () => Effect.Effect<void> = () => Effect.void,
          ) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                inFlight += 1;

                if (inFlight > maxInFlight) maxInFlight = inFlight;

                yield* onStart();

                if (inFlight >= 4) yield* reachedFour.open;
              }),
              () => (gate ? gate.await.pipe(Effect.andThen(run)) : run),
              () =>
                Effect.sync(() => {
                  inFlight -= 1;
                }).pipe(Effect.andThen(onEnd())),
            );

          const concurrentChain = Layer.effect(
            Chain,
            Effect.gen(function* () {
              const actual = yield* Chain;

              return Chain.of({
                ...actual,
                holdings: (address, assets) =>
                  assets.length > 1
                    ? trackRead(
                        claimableStarted,
                        actual.holdings(address, assets),
                        () =>
                          Effect.sync(() => {
                            initialReads += 1;
                          }),
                      )
                    : trackRead(
                        releaseConfirms,
                        actual.holdings(address, assets),
                        () =>
                          Effect.sync(() => {
                            holdingsConfirms += 1;
                          }),
                      ),
                claimable: (balances) =>
                  balances.length > 1
                    ? trackRead(
                        releaseInitialClaimable,
                        actual.claimable(balances),
                        () =>
                          Effect.sync(() => {
                            initialReads += 1;
                          }).pipe(Effect.andThen(claimableStarted.open)),
                        () => initialClaimableDone.open,
                      )
                    : trackRead(
                        releaseConfirms,
                        actual.claimable(balances),
                        () =>
                          Effect.sync(() => {
                            claimableConfirms += 1;
                          }),
                      ),
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

          const overview = yield* Effect.gen(function* () {
            const saturated = yield* reachedFour.await.pipe(
              Effect.timeoutOption("2 seconds"),
            );

            expect(Option.isSome(saturated)).toBe(true);

            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* releaseInitialClaimable.open;

            const claimableFinished = yield* initialClaimableDone.await.pipe(
              Effect.timeoutOption("2 seconds"),
            );

            expect(Option.isSome(claimableFinished)).toBe(true);

            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
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
          expect(initialReads).toBe(2);
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
  },
);
