import { assertTagged } from "./tagged";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as TestClock from "effect/testing/TestClock";
import { AssetOrders, AssetProposed } from "../src/server/AssetOrders.server";
import { walletLock } from "../src/server/slot.server";
import { Transfers } from "../src/server/Transfers.server";
import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
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
import { approvalMargin, paymentLifetime } from "../src/stellar/network";
import {
  addressOf,
  approve,
  create,
  fakeChain,
  fundHolder,
  orderFor,
  send,
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

    it.effect.each([
      {
        name: "the wallet advisory lock",
        locktype: "advisory",
        acquire: (address: ReturnType<typeof addressOf>) => walletLock(address),
      },
      {
        name: "the post-lock slot query",
        locktype: "relation",
        acquire: () => sql`lock table transfers in access exclusive mode`,
      },
    ])(
      "asset authorization keeps an order proposed when waiting on $name crosses the approval margin",
      ({ locktype, acquire }) =>
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
          const BackendPid = Schema.Struct({ pid: Schema.Number });

          const outcome = yield* Effect.gen(function* () {
            yield* TestClock.setTime(now);

            const blockerPid = yield* Deferred.make<number>();
            const releaseLock = yield* Latch.make();

            const holder = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  const pid = Schema.decodeUnknownSync(BackendPid)(
                    (yield* tx.execute(sql`select pg_backend_pid() as pid`))
                      .rows[0],
                  ).pid;

                  yield* tx.execute(acquire(addressOf(key)));
                  yield* Deferred.succeed(blockerPid, pid);
                  yield* releaseLock.await;
                }),
              )
              .pipe(Effect.forkChild);

            const pid = yield* Deferred.await(blockerPid);

            const attempt = yield* AssetOrders.use((service) =>
              service.authorize(stored, sealed),
            ).pipe(Effect.forkChild);

            while (
              (yield* db.execute(
                sql`select 1 from pg_locks where locktype = ${locktype} and not granted and ${pid} = any(pg_blocking_pids(pid))`,
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
