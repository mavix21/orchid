import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Approval,
  type SigningRequest,
  AssetCode,
  AssetOrder,
  AddressRecipient,
  AssetOrderId,
  BalanceId,
  baseAsset,
  ClaimBalance,
  CloseTrustline,
  ClaimableLimitReached,
  InsufficientBalance,
  IssuedAsset,
  NativeAsset,
  OpenTrustline,
  PositiveAmount,
  Profile,
  RecipientCannotReceive,
  ResolvedRecipient,
  TransferOrder,
  Username,
  UsernameRecipient,
} from "../src/contract";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Chain } from "../src/server/Chain.server";
import { transfers, trustlines } from "../src/server/tables.server";
import { OrderJson, Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { epochAt, network } from "../src/stellar/network";
import { assertTagged } from "./tagged";
import {
  addressOf,
  accountState,
  amount,
  approve,
  fakeChain,
  fundHolder,
  fundedWallet,
  holdingsFor,
  orderFor,
  overviewOf,
  runAcrossLockWait,
  send,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  walletWithChain,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const asset = IssuedAsset.make({
  code: Schema.decodeSync(AssetCode)("EUR"),
  issuer: addressOf(Keypair.random()),
});

const manage = (
  order: AssetOrder,
  approval: Option.Option<Approval> = Option.none(),
) => Wallet.use((w) => w.manage(order, approval));

const assetOrder = (key: Keypair, action: AssetOrder["action"]) =>
  new AssetOrder({
    id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
    wallet: addressOf(key),
    action,
  });

const euroLine = (bal: string) => ({
  asset,
  balance: amount(bal),
  spendable: amount(bal),
  capacity: amount("9223372036854775807"),
  authorized: true,
  clawbackEnabled: false,
  sponsored: true,
});

const seedPortfolio = Effect.fn(function* (key: Keypair, username: string) {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;
  const epoch = epochAt(now);
  const owner = addressOf(key);
  const ownerName = Schema.decodeSync(Username)(username);

  yield* db.insert(trustlines).values(
    ["EUR", "GBP", "JPY"].map((code) => ({
      address: owner,
      network,
      testnetEpoch: epoch,
      code: Schema.decodeSync(AssetCode)(code),
      issuer: addressOf(Keypair.random()),
    })),
  );

  const RecipientJson = Schema.fromJsonString(ResolvedRecipient);
  const profile = new Profile({ address: owner, username: ownerName });

  const balances = [0, 1, 2].map((i) =>
    Schema.decodeSync(BalanceId)(`000000000${i}${"a".repeat(62)}`),
  );

  yield* db.insert(transfers).values(
    balances.map((balanceId) => {
      const payment = orderFor(
        key,
        UsernameRecipient.make({ value: ownerName }),
      );

      return {
        id: payment.id,
        sender: owner,
        recipient: owner,
        destination: owner,
        order: Schema.encodeSync(OrderJson)(payment),
        resolvedRecipient: Schema.encodeSync(RecipientJson)(profile),
        amount: payment.amount,
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

  const transientBalance = balances[0];

  if (!transientBalance) throw new Error("Expected balance id");

  world.claimables.set(transientBalance, {
    balance: transientBalance,
    asset,
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
    sponsored: true,
    claimants: [new Claimant(owner, Claimant.predicateUnconditional())],
  });

  return { owner, transientBalance };
});

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "sponsored trustline approval survives submit failure and sweep records settlement",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet("assetowner");
          const opening = assetOrder(key, OpenTrustline.make({ asset }));
          const draft = yield* manage(opening);

          assertTagged(draft, "AssetDraft");
          expect(
            Option.getOrThrow(readEnvelope(draft.request.envelope))._tag,
          ).toBe("TrustlineFacts");

          world.failSubmit = true;
          expect(
            (yield* manage(opening, approve(draft.request, key)))._tag,
          ).toBe("AssetPending");
          expect(
            (yield* manage(assetOrder(key, OpenTrustline.make({ asset }))))
              ._tag,
          ).toBe("AssetBusy");

          world.failSubmit = false;
          yield* sweep;
          const submitted = world.submitted.at(-1);

          if (!submitted) throw new Error("Expected submission");

          settleHash(submitted.hash);
          yield* sweep;

          const settled = yield* manage(opening);

          assertTagged(settled, "AssetSettled");
          expect(settled.id).toBe(opening.id);
        }),
    );

    it.effect(
      "ledger reserve cap and nonzero trustline prevent new sponsored entries and removal",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet("limitowner");
          const addr = addressOf(key);

          world.holdings.set(
            addr,
            holdingsFor(addr, {
              reserves: { subentries: 6, sponsored: 8, sponsoring: 0 },
            }),
          );
          expect(
            (yield* manage(assetOrder(key, OpenTrustline.make({ asset }))))
              ._tag,
          ).toBe("TrustlineLimitReached");

          world.holdings.set(
            addr,
            holdingsFor(addr, { lines: [euroLine("1")] }),
          );
          expect(
            (yield* manage(assetOrder(key, CloseTrustline.make({ asset }))))
              ._tag,
          ).toBe("TrustlineNotEmpty");
        }),
    );

    it.effect(
      "missing recipient trustline uses a sponsored claimable and claim opens the line atomically",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("assetsender");
          const recipient = yield* fundedWallet("assetrecipient");
          const senderAddr = addressOf(sender);

          world.holdings.set(
            senderAddr,
            holdingsFor(senderAddr, { lines: [euroLine("50000000")] }),
          );

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
            (yield* send(payment, approve(draft.request, sender)))._tag,
          ).toBe("Pending");
          yield* sweep;
          expect(
            yield* Transfers.use((s) => s.openClaimables(senderAddr)),
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

          const claimOrder = assetOrder(
            recipient,
            ClaimBalance.make({ balance: facts.balance }),
          );

          const claimDraft = yield* manage(claimOrder);

          assertTagged(claimDraft, "AssetDraft");

          const claimed = Option.getOrThrow(
            readEnvelope(claimDraft.request.envelope),
          );

          assertTagged(claimed, "ClaimFacts");
          expect(claimed.opens).toEqual(asset);
          expect(
            (yield* manage(claimOrder, approve(claimDraft.request, recipient)))
              ._tag,
          ).toBe("AssetPending");
        }),
    );

    it.effect(
      "a claimable drafted before the second slot fills is refused at approval",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("quotasender");
          const senderAddr = addressOf(sender);

          const recipientAddress = addressOf(
            yield* fundedWallet("quotarecipient"),
          );

          world.holdings.set(
            senderAddr,
            holdingsFor(senderAddr, { lines: [euroLine("50000000")] }),
          );

          const claimable = () =>
            new TransferOrder({
              ...orderFor(
                sender,
                UsernameRecipient.make({
                  value: Schema.decodeSync(Username)("quotarecipient"),
                }),
              ),
              asset,
            });

          const draftAt = Effect.fn(function* (
            order: TransferOrder,
            sequence: string,
          ) {
            world.accounts.set(senderAddr, accountState({ sequence }));

            return yield* send(order);
          });

          const settle = Effect.fn(function* (
            order: TransferOrder,
            draft: SigningRequest,
          ) {
            expect((yield* send(order, approve(draft, sender)))._tag).toBe(
              "Pending",
            );

            const submitted = world.submitted.at(-1);
            const facts = Option.getOrThrow(readEnvelope(draft.envelope));

            if (!submitted) throw new Error("Expected submission");

            assertTagged(facts, "ClaimableFacts");
            world.claimables.set(facts.balance, {
              balance: facts.balance,
              asset,
              amount: Schema.decodeSync(PositiveAmount)("10000000"),
              sponsored: true,
              claimants: [
                new Claimant(
                  recipientAddress,
                  Claimant.predicateUnconditional(),
                ),
              ],
            });
            settleHash(submitted.hash);
            yield* sweep;
          });

          const first = claimable();
          const firstDraft = yield* draftAt(first, "2000");

          assertTagged(firstDraft, "TransferDraft");
          yield* settle(first, firstDraft.request);

          const second = claimable();
          const third = claimable();
          const secondDraft = yield* draftAt(second, "3000");
          const thirdDraft = yield* send(third);

          assertTagged(secondDraft, "TransferDraft");
          assertTagged(thirdDraft, "TransferDraft");
          yield* settle(second, secondDraft.request);

          expect(
            yield* Transfers.use((s) => s.openClaimables(senderAddr)),
          ).toBe(2);
          expect(
            yield* send(third, approve(thirdDraft.request, sender)),
          ).toEqual(new ClaimableLimitReached({ limit: 2 }));
        }),
    );

    it.effect(
      "a payment above the destination's incoming capacity is refused before drafting",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("capacitysender");
          const destinationKey = Keypair.random();
          const destination = addressOf(destinationKey);

          fundHolder(destinationKey);

          const order = orderFor(
            sender,
            AddressRecipient.make({ value: destination }),
          );

          const holdingWithCapacity = (capacity: string) =>
            holdingsFor(destination, {
              lines: [
                {
                  ...euroLine("0"),
                  asset: baseAsset,
                  capacity: amount(capacity),
                },
              ],
            });

          world.holdings.set(destination, holdingWithCapacity("9999999"));
          expect(yield* send(order)).toEqual(
            new RecipientCannotReceive({
              address: destination,
              reason: "no_capacity",
            }),
          );

          world.holdings.set(destination, holdingWithCapacity("10000000"));
          assertTagged(yield* send(order), "TransferDraft");

          world.holdings.set(destination, holdingWithCapacity("9999999"));
          world.accounts.set(
            addressOf(sender),
            accountState({ sequence: "5000" }),
          );
          expect(yield* send(order)).toEqual(
            new RecipientCannotReceive({
              address: destination,
              reason: "no_capacity",
            }),
          );
        }),
    );

    it.effect(
      "native sends spend only available XLM and empty trustline removal stays holder signed",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet("nativeowner");
          const addr = addressOf(key);

          world.holdings.set(
            addr,
            holdingsFor(addr, {
              native: amount("5000000"),
              lines: [euroLine("0")],
            }),
          );

          const native = new TransferOrder({
            ...orderFor(
              key,
              UsernameRecipient.make({
                value: Schema.decodeSync(Username)("nativeowner"),
              }),
            ),
            asset: NativeAsset.make({}),
          });

          expect(yield* send(native)).toEqual(
            new InsufficientBalance({ available: amount("5000000") }),
          );

          world.holdings.set(
            addr,
            holdingsFor(addr, {
              native: amount("50000000"),
              lines: [euroLine("0")],
            }),
          );

          const draft = yield* send(native);

          assertTagged(draft, "TransferDraft");
          expect(
            Option.getOrThrow(readEnvelope(draft.request.envelope)),
          ).toMatchObject({ asset: NativeAsset.make({}) });

          const close = assetOrder(key, CloseTrustline.make({ asset }));
          const removal = yield* manage(close);

          assertTagged(removal, "AssetDraft");
          expect(
            (yield* manage(close, approve(removal.request, Keypair.random())))
              ._tag,
          ).toBe("AssetDraft");
          expect(
            (yield* manage(close, approve(removal.request, key)))._tag,
          ).toBe("AssetPending");
        }),
    );

    it.effect(
      "overview shares one concurrency budget of four across holdings and claimables",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet("concurrentowner");

          const { owner, transientBalance } = yield* seedPortfolio(
            key,
            "concurrentowner",
          );

          const reachedFour = yield* Latch.make();
          const releaseConfirms = yield* Latch.make();
          let inFlight = 0;
          let maxInFlight = 0;

          const holdConfirm = <A, E>(run: Effect.Effect<A, E>) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                inFlight += 1;

                if (inFlight > maxInFlight) maxInFlight = inFlight;

                if (inFlight >= 4) yield* reachedFour.open;
              }),
              () => releaseConfirms.await.pipe(Effect.andThen(run)),
              () =>
                Effect.sync(() => {
                  inFlight -= 1;
                }),
            );

          const concurrentWallet = walletWithChain((actual) => ({
            holdings: (addr, assets) =>
              assets.length > 1
                ? actual.holdings(addr, assets)
                : holdConfirm(actual.holdings(addr, assets)),
            claimable: (ids) =>
              ids.length > 1
                ? actual.claimable(ids.filter((id) => id !== transientBalance))
                : holdConfirm(actual.claimable(ids)),
          }));

          const fiber = yield* overviewOf(owner).pipe(
            Effect.provide(concurrentWallet),
            Effect.forkChild,
          );

          const overview = yield* Effect.gen(function* () {
            expect(
              Option.isSome(
                yield* reachedFour.await.pipe(
                  Effect.timeoutOption("2 seconds"),
                ),
              ),
            ).toBe(true);
            yield* releaseConfirms.open;

            return yield* Fiber.join(fiber);
          }).pipe(Effect.ensuring(releaseConfirms.open));

          assertTagged(overview, "Holding");
          expect(maxInFlight).toBe(4);
          expect(yield* AssetOrders.use((s) => s.tracked(owner))).toEqual([]);
          expect(
            (yield* Transfers.use((s) => s.openBalances(owner))).map(
              (i) => i.balance,
            ),
          ).toEqual([transientBalance]);
        }),
    );

    it.effect(
      "asset authorization keeps an order proposed when waiting on the post-lock slot query crosses the approval margin",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet("assetlockowner");
          const opening = assetOrder(key, OpenTrustline.make({ asset }));

          assertTagged(yield* manage(opening), "AssetDraft");

          const stored = Option.getOrThrow(
            yield* AssetOrders.use((s) => s.find(opening.id)),
          );

          assertTagged(stored, "AssetProposed");

          const sealed = yield* Chain.use((c) =>
            c.seal(
              stored.request,
              Option.getOrThrow(approve(stored.request, key)),
              addressOf(key),
            ),
          ).pipe(Effect.provide(fakeChain));

          const { result: outcome } = yield* runAcrossLockWait({
            locktype: "relation",
            advance: "101 seconds",
            acquire: (tx) =>
              tx.execute(sql`lock table transfers in access exclusive mode`),
            run: AssetOrders.use((s) => s.authorize(stored, sealed)),
          });

          expect(outcome._tag).toBe("AssetProposed");
          expect(
            Option.getOrThrow(yield* AssetOrders.use((s) => s.find(opening.id)))
              ._tag,
          ).toBe("AssetProposed");
        }),
    );
  },
);
