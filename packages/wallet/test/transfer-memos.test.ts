import * as Effect from "effect/Effect";
import { expect, layer } from "@effect/vitest";
import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  ExternalRecipient,
  ExternalMemoRequired,
  MemoNotAllowed,
  PaymentMemo,
  Pending,
  Settled,
  TransferDraft,
  TransferOrder,
} from "../src/contract";
import { Applied } from "../src/server/Chain.server";
import {
  Authorized,
  Proposed,
  Transfers,
} from "../src/server/Transfers.server";
import { PaymentFacts, readEnvelope } from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import {
  world,
  addressOf,
  registerExchange,
  approve,
  create,
  orderFor,
  send,
  fundHolder,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "unlisted external destinations accept no memo and expose that a memo is optional",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const destinationKey = Keypair.random();
          fundHolder(destinationKey);
          const destination = addressOf(destinationKey);

          const order = orderFor(
            key,
            AddressRecipient.make({ value: destination }),
          );

          const draft = yield* send(order);

          if (!(draft instanceof TransferDraft))
            throw new Error("Expected external draft");

          expect(draft.recipient).toEqual(
            new ExternalRecipient({ address: destination }),
          );
          expect(draft.memoRequired).toBe(false);
          const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

          if (!(facts instanceof PaymentFacts))
            throw new Error("Expected payment facts");

          expect(facts.memo).toBeUndefined();
          expect(
            yield* send(order, approve(draft.request, key)),
          ).toBeInstanceOf(Pending);

          const signed = Option.getOrThrow(
            yield* Transfers.use((service) => service.find(order.id)),
          );

          if (!(signed instanceof Authorized))
            throw new Error("Expected authorization");

          expect(signed.order.memo).toBeUndefined();

          const outer = TransactionBuilder.fromXDR(
            signed.sealed.envelope,
            networkPassphrase,
          );

          if (!(outer instanceof FeeBumpTransaction))
            throw new Error("Expected fee bump");

          expect(outer.innerTransaction.memo.type).toBe("none");
          world.evidence.set(
            signed.sealed.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );
          const receipt = yield* send(order);

          if (!(receipt instanceof Settled))
            throw new Error("Expected settled receipt");

          expect(receipt.memo).toBeUndefined();
        }),
    );

    it.effect(
      "known exchange destinations refuse missing memos with client-visible source evidence",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");

          const entry = registerExchange(addressOf(Keypair.random()));

          const order = orderFor(
            key,
            AddressRecipient.make({ value: entry.address }),
          );

          const initialSubmissions = world.submitted.length;

          expect(yield* send(order)).toEqual(
            new ExternalMemoRequired({
              address: entry.address,
              exchange: entry.exchange,
              source: entry.source,
            }),
          );
          expect(
            Option.isNone(
              yield* Transfers.use((service) => service.find(order.id)),
            ),
          ).toBe(true);
          expect(world.submitted).toHaveLength(initialSubmissions);
        }),
    );

    it.effect(
      "a new registry entry blocks an unsigned draft but preserves an authorized external transfer",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const destinationKey = Keypair.random();
          fundHolder(destinationKey);
          const destination = addressOf(destinationKey);

          const order = orderFor(
            key,
            AddressRecipient.make({ value: destination }),
          );

          const draft = yield* send(order);

          if (!(draft instanceof TransferDraft))
            throw new Error("Expected draft");

          registerExchange(destination);
          expect(
            yield* send(order, approve(draft.request, key)),
          ).toBeInstanceOf(ExternalMemoRequired);
          expect(
            Option.getOrThrow(
              yield* Transfers.use((service) => service.find(order.id)),
            ),
          ).toBeInstanceOf(Proposed);
          world.exchangeMemos.length = 0;
          expect(
            yield* send(order, approve(draft.request, key)),
          ).toBeInstanceOf(Pending);
          registerExchange(destination);
          expect(yield* send(order)).toBeInstanceOf(Pending);
        }),
    );

    it.effect(
      "external text/id memos survive draft, signature, durable order and receipt; Orchid memos are refused",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();

          yield* create(key, "maria");
          fundHolder(key);

          const memos: ReadonlyArray<PaymentMemo> = [
            { type: "text", value: "deposit-123" },
            { type: "id", value: "18446744073709551615" },
          ];

          for (const required of [false, true]) {
            for (const memo of memos) {
              const destinationKey = Keypair.random();
              fundHolder(destinationKey);
              const destination = addressOf(destinationKey);

              if (required) registerExchange(destination);

              const order = new TransferOrder({
                ...orderFor(key, AddressRecipient.make({ value: destination })),
                memo: Schema.decodeUnknownSync(PaymentMemo)(memo),
              });

              const draft = yield* send(order);

              if (!(draft instanceof TransferDraft))
                throw new Error("Expected memo draft");

              expect(draft.recipient).toBeInstanceOf(ExternalRecipient);
              expect(draft.memoRequired).toBe(required);

              const facts = Option.getOrThrow(
                readEnvelope(draft.request.envelope),
              );

              if (!(facts instanceof PaymentFacts))
                throw new Error("Expected payment facts");

              expect(facts.memo).toEqual(memo);
              yield* send(order, approve(draft.request, key));

              const signed = Option.getOrThrow(
                yield* Transfers.use((service) => service.find(order.id)),
              );

              if (!(signed instanceof Authorized))
                throw new Error("Expected authorization");

              expect(signed.order.memo).toEqual(memo);
              world.evidence.set(
                signed.sealed.hash,
                new Applied({ at: DateTime.nowUnsafe() }),
              );

              const receipt = yield* send(order);

              if (!(receipt instanceof Settled))
                throw new Error("Expected receipt");

              expect(receipt.memo).toEqual(memo);
              expect(receipt.recipient).toEqual(
                new ExternalRecipient({ address: destination }),
              );
            }
          }

          registerExchange(addressOf(key));

          const plain = yield* send(
            orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
          );

          if (!(plain instanceof TransferDraft))
            throw new Error("Expected Orchid draft");

          expect(plain.memoRequired).toBe(false);

          const orchid = new TransferOrder({
            ...orderFor(key, AddressRecipient.make({ value: addressOf(key) })),
            memo: Schema.decodeSync(PaymentMemo)({
              type: "text",
              value: "unwanted",
            }),
          });

          expect(yield* send(orchid)).toBeInstanceOf(MemoNotAllowed);
          expect(
            Option.isNone(
              yield* Transfers.use((service) => service.find(orchid.id)),
            ),
          ).toBe(true);
        }),
    );
  },
);
