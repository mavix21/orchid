import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Amount,
  LedgerUnreachable,
  PositiveAmount,
  ServerFailure,
  ServiceFailed,
  TransferOrder,
  Username,
  UsernameRecipient,
} from "../src/contract";
import { Wallet } from "../src/server/Wallet.server";
import {
  addressOf,
  create,
  orderFor,
  send,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const fundedSender = Effect.fn(function* () {
  const key = Keypair.random();

  yield* create(key, "maria");
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
