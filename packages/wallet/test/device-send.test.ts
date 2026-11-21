import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssetCode,
  IssuedAsset,
  Offline,
  PositiveAmount,
  Settled,
  Username,
  UsernameRecipient,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { TransferIntent, makeWalletEffects } from "../src/device/client";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { Wallet } from "../src/server/Wallet.server";
import { memoryKeyStore, savedWallet } from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import {
  accountState,
  addressOf,
  amount,
  create,
  holdingsFor,
  passkeyOrigin,
  reserveSponsor,
  settleHash,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const passkeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;

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

  yield* makeWalletEffects(wallet, store, passkeys).create("maria");
  const sender = yield* savedWallet(store);

  world.accounts.set(sender.address, accountState());

  return { wallet, sender };
});

const settleOnSubmission =
  (wallet: WalletPort): WalletPort["transfer"] =>
  (order, approval) =>
    wallet.transfer(order, approval).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sealed = world.submitted.at(-1);

          if (Option.isSome(approval) && sealed) settleHash(sealed.hash);
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
          const { wallet } = yield* openSender(store);

          const reloaded: WalletPort = {
            ...wallet,
            transfer: (order, approval) =>
              Option.isSome(approval)
                ? wallet
                    .transfer(order, approval)
                    .pipe(Effect.andThen(Effect.fail(new Offline())))
                : wallet.transfer(order, approval),
          };

          expect(
            (yield* makeWalletEffects(reloaded, store, passkeys).send(toPedro))
              ._tag,
          ).toBe("Offline");
          const stored = (yield* savedWallet(store)).transfer;
          const sealed = world.submitted.at(-1);
          const submissions = world.submitted.length;

          if (!stored || !sealed) throw new Error("Expected a signed order");

          settleHash(sealed.hash);

          const replayed = yield* makeWalletEffects(
            wallet,
            store,
            passkeys,
          ).send(toPedro);

          expect(replayed instanceof Settled && replayed.id).toBe(stored.id);
          expect(world.submitted).toHaveLength(submissions);
        }),
    );

    it.effect(
      "a restored wallet learns its reserve sponsor from overview and approves a claimable",
      () =>
        Effect.gen(function* () {
          yield* create(Keypair.random(), "pedro");
          const { wallet, sender } = yield* openSender(memoryKeyStore());
          const held = amount("50000000");

          world.holdings.set(
            sender.address,
            holdingsFor(sender.address, {
              reserveSponsor: Option.some(reserveSponsor),
              lines: [
                {
                  asset: euro,
                  balance: held,
                  spendable: held,
                  capacity: held,
                  authorized: true,
                  sponsored: true,
                },
              ],
            }),
          );

          const restored = memoryKeyStore(
            Option.some(
              new DeviceWallet({ ...sender, reserveSponsor: undefined }),
            ),
          );

          const settledPort: WalletPort = {
            ...wallet,
            transfer: settleOnSubmission(wallet),
          };

          const client = makeWalletEffects(settledPort, restored, passkeys);

          yield* client.overview();

          const sent = yield* client.send(
            new TransferIntent({ ...toPedro, asset: euro }),
          );

          expect(sent instanceof Settled && sent.claimable !== undefined).toBe(
            true,
          );
        }),
    );
  },
);
