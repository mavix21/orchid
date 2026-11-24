import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Approval,
  type SigningRequest,
  AssetOrder,
  AddressRecipient,
  AssetOrderId,
  baseAsset,
  ClaimBalance,
  CloseTrustline,
  ClaimableLimitReached,
  InsufficientBalance,
  NativeAsset,
  OpenTrustline,
  PositiveAmount,
  RecipientCannotReceive,
  TransferOrder,
  Username,
  UsernameRecipient,
} from "../src/contract";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Sealed } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { WalletInactive } from "../src/server/slot.server";
import { Wallet } from "../src/server/Wallet.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { assertTagged } from "./tagged";
import {
  addressOf,
  accountState,
  amount,
  approve,
  euro,
  euroLine,
  fundHolder,
  fundedWallet,
  holdingsFor,
  orderFor,
  send,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

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

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "an asset order is not authorized once its wallet stopped being active",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet("assetowner");
          const opening = assetOrder(key, OpenTrustline.make({ asset: euro }));

          assertTagged(yield* manage(opening), "AssetDraft");

          const proposed = Option.getOrThrow(
            yield* AssetOrders.use((orders) => orders.find(opening.id)),
          );

          assertTagged(proposed, "AssetProposed");
          yield* Directory.use((directory) =>
            Effect.flatMap(directory.byAddress(addressOf(key)), (row) =>
              directory.recover(Option.getOrThrow(row)),
            ),
          );
          expect(
            yield* AssetOrders.use((orders) =>
              orders.authorize(
                proposed,
                new Sealed({
                  envelope: "AAAA",
                  hash: "00".repeat(32),
                  expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
                }),
              ),
            ),
          ).toEqual(new WalletInactive());
          assertTagged(
            Option.getOrThrow(
              yield* AssetOrders.use((orders) => orders.find(opening.id)),
            ),
            "AssetProposed",
          );
        }),
    );

    it.effect(
      "sponsored trustline approval survives submit failure and sweep records settlement",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet("assetowner");
          const opening = assetOrder(key, OpenTrustline.make({ asset: euro }));
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
            (yield* manage(
              assetOrder(key, OpenTrustline.make({ asset: euro })),
            ))._tag,
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
            (yield* manage(
              assetOrder(key, OpenTrustline.make({ asset: euro })),
            ))._tag,
          ).toBe("TrustlineLimitReached");

          world.holdings.set(
            addr,
            holdingsFor(addr, { lines: [euroLine("1")] }),
          );
          expect(
            (yield* manage(
              assetOrder(key, CloseTrustline.make({ asset: euro })),
            ))._tag,
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
            asset: euro,
          });

          const draft = yield* send(payment);

          assertTagged(draft, "TransferDraft");

          const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

          assertTagged(facts, "ClaimableFacts");
          expect(
            (yield* send(payment, approve(draft.request, sender)))._tag,
          ).toBe("Pending");
          yield* sweep;

          world.claimables.set(facts.balance, {
            balance: facts.balance,
            asset: euro,
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
          expect(claimed.opens).toEqual(euro);
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
              asset: euro,
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
              asset: euro,
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
              linkable: false,
            }),
          );

          world.holdings.set(destination, holdingWithCapacity("10000000"));
          assertTagged(yield* send(order), "TransferDraft");
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

          const close = assetOrder(key, CloseTrustline.make({ asset: euro }));
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
  },
);
