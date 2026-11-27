import { expect, layer } from "@effect/vitest";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  AddressRecipient,
  ExternalMemoRequired,
  ExternalRecipient,
  LedgerUnreachable,
  MemoNotAllowed,
  DestinationAddress,
  nativeAsset,
  PaymentMemo,
  TransferOrder,
} from "../src/contract";
import { KnownExchangeMemo } from "../src/stellar/exchange-memos.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { network } from "../src/stellar/network";
import { assertTagged } from "./tagged";
import {
  addressOf,
  amount,
  approve,
  draftTransfer,
  findTransfer,
  fundHolder,
  fundedWallet,
  holdingsFor,
  orderFor,
  selfOrder,
  send,
  settleHash,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const registerExchange = (address: AccountAddress) => {
  const entry = new KnownExchangeMemo({
    network,
    address,
    exchange: "Synthetic exchange fixture",
    source: "https://example.com/fixtures/stellar-testnet-memo-required",
  });

  world.exchangeMemos.push(entry);

  return entry;
};

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "known exchange destinations refuse missing memos with client-visible source evidence",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const entry = registerExchange(addressOf(Keypair.random()));

          const order = orderFor(
            key,
            AddressRecipient.make({ value: entry.address }),
          );

          const initial = world.submitted.length;

          expect(yield* send(order)).toEqual(
            new ExternalMemoRequired({
              address: entry.address,
              exchange: entry.exchange,
              source: entry.source,
            }),
          );
          expect(Option.isNone(yield* findTransfer(order.id))).toBe(true);
          expect(world.submitted).toHaveLength(initial);
        }),
    );

    it.effect(
      "a muxed destination pays the muxed address without a memo through its base account",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const baseKey = yield* fundedWallet("pedro");

          const base = addressOf(baseKey);

          registerExchange(base);

          const muxed = Schema.decodeSync(DestinationAddress)(
            new MuxedAccount(new Account(base, "0"), "42").accountId(),
          );

          const order = orderFor(key, AddressRecipient.make({ value: muxed }));
          const draft = yield* draftTransfer(order);

          expect(draft.recipient).toEqual(
            new ExternalRecipient({ address: muxed }),
          );
          expect(draft.memoRequired).toBe(false);

          const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

          assertTagged(facts, "PaymentFacts");
          expect(facts.to).toBe(muxed);
          expect(facts.memo).toBeUndefined();

          const withMemo = new TransferOrder({
            ...orderFor(key, AddressRecipient.make({ value: muxed })),
            memo: Schema.decodeSync(PaymentMemo)({ type: "id", value: "42" }),
          });

          expect(yield* send(withMemo)).toEqual(
            new MemoNotAllowed({ reason: "muxed" }),
          );
          expect(Option.isNone(yield* findTransfer(withMemo.id))).toBe(true);

          const missing = Schema.decodeSync(DestinationAddress)(
            new MuxedAccount(
              new Account(addressOf(Keypair.random()), "0"),
              "42",
            ).accountId(),
          );

          expect(
            (yield* send(
              orderFor(key, AddressRecipient.make({ value: missing })),
            ))._tag,
          ).toBe("RecipientCannotReceive");
        }),
    );

    it.effect(
      "a new registry entry blocks an unsigned draft but preserves an authorized external transfer",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const destKey = Keypair.random();

          fundHolder(destKey);
          const destination = addressOf(destKey);

          const order = orderFor(
            key,
            AddressRecipient.make({ value: destination }),
          );

          const draft = yield* draftTransfer(order);

          registerExchange(destination);
          expect((yield* send(order, approve(draft.request, key)))._tag).toBe(
            "ExternalMemoRequired",
          );
          expect(Option.getOrThrow(yield* findTransfer(order.id))._tag).toBe(
            "Proposed",
          );

          world.exchangeMemos.length = 0;
          expect((yield* send(order, approve(draft.request, key)))._tag).toBe(
            "Pending",
          );

          registerExchange(destination);
          expect((yield* send(order))._tag).toBe("Pending");
        }),
    );

    it.effect(
      "an unreachable ledger refuses an unsigned external step without storing it but leaves an authorized transfer pending",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const destKey = Keypair.random();

          fundHolder(destKey);

          for (const holder of [key, destKey])
            world.holdings.set(
              addressOf(holder),
              holdingsFor(addressOf(holder), { native: amount("50000000") }),
            );

          const order = new TransferOrder({
            ...orderFor(
              key,
              AddressRecipient.make({ value: addressOf(destKey) }),
            ),
            asset: nativeAsset,
          });

          world.ledgerDown = true;
          expect(yield* send(order).pipe(Effect.flip)).toEqual(
            new LedgerUnreachable(),
          );
          expect(Option.isNone(yield* findTransfer(order.id))).toBe(true);
          world.ledgerDown = false;

          const draft = yield* draftTransfer(order);

          expect((yield* send(order, approve(draft.request, key)))._tag).toBe(
            "Pending",
          );
          world.ledgerDown = true;
          expect((yield* send(order))._tag).toBe("Pending");
        }),
    );

    it.effect(
      "a required exchange memo survives order and receipt while Orchid memos are refused",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const exKey = Keypair.random();

          fundHolder(exKey);
          const exchange = addressOf(exKey);

          registerExchange(exchange);

          const memo = Schema.decodeSync(PaymentMemo)({
            type: "text",
            value: "deposit-123",
          });

          const memoOrder = new TransferOrder({
            ...orderFor(key, AddressRecipient.make({ value: exchange })),
            memo,
          });

          const memoDraft = yield* draftTransfer(memoOrder);

          expect(memoDraft.recipient).toBeInstanceOf(ExternalRecipient);
          expect(memoDraft.memoRequired).toBe(true);

          const memoFacts = Option.getOrThrow(
            readEnvelope(memoDraft.request.envelope),
          );

          assertTagged(memoFacts, "PaymentFacts");
          expect(memoFacts.memo).toEqual(memo);
          yield* send(memoOrder, approve(memoDraft.request, key));

          const memoSigned = Option.getOrThrow(
            yield* findTransfer(memoOrder.id),
          );

          assertTagged(memoSigned, "Authorized");
          expect(memoSigned.order.memo).toEqual(memo);
          settleHash(memoSigned.sealed.hash);

          const memoReceipt = yield* send(memoOrder);

          assertTagged(memoReceipt, "Settled");
          expect(memoReceipt.memo).toEqual(memo);
          expect(memoReceipt.recipient).toEqual(
            new ExternalRecipient({ address: exchange }),
          );

          registerExchange(addressOf(key));
          expect((yield* draftTransfer(selfOrder(key))).memoRequired).toBe(
            false,
          );

          const orchid = new TransferOrder({
            ...selfOrder(key),
            memo: Schema.decodeSync(PaymentMemo)({
              type: "text",
              value: "unwanted",
            }),
          });

          expect((yield* send(orchid))._tag).toBe("MemoNotAllowed");
          expect(Option.isNone(yield* findTransfer(orchid.id))).toBe(true);
        }),
    );
  },
);
