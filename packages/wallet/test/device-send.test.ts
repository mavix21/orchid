import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Amount,
  AssetCode,
  IssuedAsset,
  PositiveAmount,
  Settled,
  Username,
  UsernameRecipient,
  WalletUnavailable,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { TransferIntent, makeWalletClient } from "../src/device/client";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { Applied } from "../src/server/Chain.server";
import { Wallet } from "../src/server/Wallet.server";
import { SoftwareAuthenticator } from "./software-authenticator";
import {
  addressOf,
  create,
  passkeyOrigin,
  reserveSponsor,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const passkeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;

function memoryKeyStore(initial = Option.none<DeviceWallet>()) {
  let saved = initial;

  const store: KeyStore = {
    read: () => Effect.sync(() => saved),
    write: (wallet) =>
      Effect.sync(() => {
        saved = Option.some(wallet);
      }),
  };

  return store;
}

const savedWallet = (store: KeyStore) =>
  store.read().pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);

const euro = IssuedAsset.make({
  code: Schema.decodeSync(AssetCode)("EUR"),
  issuer: addressOf(Keypair.random()),
});

const toPedro = new TransferIntent({
  to: UsernameRecipient.make({ value: Schema.decodeSync(Username)("pedro") }),
  asset: baseAsset,
  amount: Schema.decodeSync(PositiveAmount)("10000000"),
});

const openSender = Effect.fn(function* (store: KeyStore) {
  const wallet = yield* Wallet;

  yield* Effect.promise(() =>
    makeWalletClient(wallet, store, passkeys).create("maria"),
  );

  const sender = yield* savedWallet(store);
  const account = world.accounts.get(sender.address);

  if (!account) throw new Error("Expected an opened sender account");

  world.accounts.set(sender.address, {
    ...account,
    balance: Option.some(Schema.decodeSync(Amount)("50000000")),
  });

  return wallet;
});

const settleOnSubmission =
  (wallet: WalletPort): WalletPort["transfer"] =>
  (order, approval) =>
    wallet.transfer(order, approval).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sealed = world.submitted.at(-1);

          if (Option.isSome(approval) && sealed)
            world.evidence.set(
              sealed.hash,
              new Applied({ at: DateTime.nowUnsafe() }),
            );
        }),
      ),
    );

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "replays the stored order after a reload and settles it once",
      () =>
        Effect.gen(function* () {
          yield* create(Keypair.random(), "pedro");

          const store = memoryKeyStore();
          const wallet = yield* openSender(store);

          const reloaded: WalletPort = {
            ...wallet,
            transfer: (order, approval) =>
              Option.isSome(approval)
                ? wallet.transfer(order, approval).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new WalletUnavailable({
                          cause: new Error("Reloaded"),
                        }),
                      ),
                    ),
                  )
                : wallet.transfer(order, approval),
          };

          expect(
            (yield* Effect.promise(() =>
              makeWalletClient(reloaded, store, passkeys).send(toPedro),
            ))._tag,
          ).toBe("Offline");

          const stored = (yield* savedWallet(store)).transfer;
          const sealed = world.submitted.at(-1);

          const submissions = world.submitted.length;

          if (!stored || !sealed) throw new Error("Expected a signed order");

          world.evidence.set(
            sealed.hash,
            new Applied({ at: DateTime.nowUnsafe() }),
          );

          const replayed = yield* Effect.promise(() =>
            makeWalletClient(wallet, store, passkeys).send(toPedro),
          );

          expect(replayed instanceof Settled && replayed.id).toBe(stored.id);
          expect(world.submitted).toHaveLength(submissions);
        }),
    );

    it.effect(
      "a restored wallet approves a claimable of an asset the recipient has not opened",
      () =>
        Effect.gen(function* () {
          yield* create(Keypair.random(), "pedro");

          const opened = memoryKeyStore();
          const wallet = yield* openSender(opened);
          const sender = yield* savedWallet(opened);
          const account = world.accounts.get(sender.address);

          if (!account) throw new Error("Expected an opened sender");

          const held = Schema.decodeSync(Amount)("50000000");

          world.holdings.set(sender.address, {
            account,
            reserveSponsor: Option.some(reserveSponsor),
            native: Schema.decodeSync(Amount)("0"),
            reserves: { subentries: 2, sponsored: 4, sponsoring: 0 },
            lines: [
              {
                asset: euro,
                balance: held,
                spendable: held,
                authorized: true,
                sponsored: true,
              },
            ],
          });

          const restored = memoryKeyStore(
            Option.some(
              new DeviceWallet({
                ...sender,
                reserveSponsor: undefined,
              }),
            ),
          );

          const client = makeWalletClient(
            { ...wallet, transfer: settleOnSubmission(wallet) },
            restored,
            passkeys,
          );

          yield* Effect.promise(() => client.overview());

          const sent = yield* Effect.promise(() =>
            client.send(new TransferIntent({ ...toPedro, asset: euro })),
          );

          expect(sent instanceof Settled && sent.claimable).toBeTruthy();
        }),
    );
  },
);
