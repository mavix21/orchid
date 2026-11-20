import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressRecipient,
  Amount,
  LedgerUnreachable,
  PositiveAmount,
  ServerFailure,
  ServiceFailed,
  TransferOrder,
  Username,
  UsernameRecipient,
} from "../src/contract";
import { Applied } from "../src/server/Chain.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { assertTagged } from "./tagged";
import {
  addressOf,
  approve,
  create,
  orderFor,
  send,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const fundedSender = Effect.fn(function* (username = "maria") {
  const key = Keypair.random();

  yield* create(key, username);
  world.accounts.set(addressOf(key), {
    sequence: "1000",
    ledger: 100,
    accountSponsored: true,
    sponsored: true,
    nativeBalance: 0n,
    balance: Option.some(Schema.decodeSync(Amount)("50000000")),
  });

  return key;
});

const signedTransfer = Effect.fn(function* (username: string) {
  const key = yield* fundedSender(username);

  const order = orderFor(key, AddressRecipient.make({ value: addressOf(key) }));

  const draft = yield* send(order);

  assertTagged(draft, "TransferDraft");
  world.failSubmit = true;
  yield* send(order, approve(draft.request, key));
  world.failSubmit = false;

  const stored = Option.getOrThrow(
    yield* Transfers.use((transfers) => transfers.find(order.id)),
  );

  assertTagged(stored, "Authorized");

  return { order, hash: stored.sealed.hash };
});

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "answers an internal failure without telling the device why",
      () =>
        Effect.gen(function* () {
          yield* create(Keypair.random(), "pedro");

          const key = yield* fundedSender();

          const order = orderFor(
            key,
            UsernameRecipient.make({
              value: Schema.decodeSync(Username)("pedro"),
            }),
          );

          yield* send(order);

          const failure = yield* send(
            new TransferOrder({
              ...order,
              amount: Schema.decodeSync(PositiveAmount)("20000000"),
            }),
          ).pipe(Effect.flip);

          expect(failure).toEqual(new ServiceFailed());
          expect(
            JSON.stringify(Schema.encodeSync(ServerFailure)(failure)),
          ).not.toMatch(/order|cause|Error/);
        }),
    );

    it.effect("keeps sweeping other records after one record's read dies", () =>
      Effect.gen(function* () {
        const unreadable = yield* signedTransfer("maria");
        const readable = yield* signedTransfer("lucia");

        world.unreadable.add(unreadable.hash);
        world.evidence.set(
          readable.hash,
          new Applied({ at: DateTime.nowUnsafe() }),
        );

        expect(
          yield* Wallet.use((wallet) => wallet.sweep).pipe(Effect.flip),
        ).toEqual(new ServiceFailed());
        expect(
          Option.getOrThrow(
            yield* Transfers.use((transfers) =>
              transfers.find(readable.order.id),
            ),
          )._tag,
        ).toBe("Concluded");
      }),
    );

    it.effect(
      "keeps reconciling transfers when the claimable-balance read fails",
      () =>
        Effect.gen(function* () {
          const signed = yield* signedTransfer("maria");

          world.claimablesDown = true;
          world.evidence.set(
            signed.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );

          expect(
            yield* Wallet.use((wallet) => wallet.sweep).pipe(Effect.flip),
          ).toEqual(new ServiceFailed());
          expect(
            Option.getOrThrow(
              yield* Transfers.use((transfers) =>
                transfers.find(signed.order.id),
              ),
            )._tag,
          ).toBe("Concluded");
        }),
    );

    it.effect("answers LedgerUnreachable when Stellar does not answer", () =>
      Effect.gen(function* () {
        const key = yield* fundedSender();

        world.ledgerDown = true;

        expect(
          yield* Wallet.use((wallet) => wallet.overview(addressOf(key))).pipe(
            Effect.flip,
          ),
        ).toEqual(new LedgerUnreachable());
      }),
    );
  },
);
