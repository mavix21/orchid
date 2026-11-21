import { Account, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type Asset,
  type ExternalRecipient,
  type PaymentMemo,
  PositiveAmount,
  Profile,
  SigningRequest,
  TransferDraft,
  type UnsignedEnvelope,
  Username,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { SecretPhrase } from "../src/device/secret-phrase";
import { signingKey } from "../src/device/signing";
import { draftClaimable } from "../src/stellar/asset-envelopes";
import { draftPayment } from "../src/stellar/envelopes";

export const addressOf = (key: Keypair) =>
  Schema.decodeSync(AccountAddress)(key.publicKey());

export const knownPhrase = Schema.decodeSync(SecretPhrase)(
  "illness spike retreat truth genius clock brain pass fit cave bargain toe",
);

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export function memoryKeyStore(
  initial = Option.none<DeviceWallet>(),
  beforeWrite: Effect.Effect<void> = Effect.void,
): KeyStore {
  let saved = initial;

  return {
    read: () => Effect.sync(() => saved),
    write: (wallet) =>
      beforeWrite.pipe(
        Effect.andThen(
          Effect.sync(() => {
            saved = Option.some(wallet);
          }),
        ),
      ),
  };
}

export const savedWallet = (store: KeyStore) =>
  store.read().pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);

export const unusedPort = (overrides: Partial<WalletPort> = {}): WalletPort => {
  const unused = () => Effect.die("Not used by test");

  return {
    overview: unused,
    open: unused,
    transfer: unused,
    manage: unused,
    passkeyChallenge: unused,
    enroll: unused,
    restore: unused,
    ...overrides,
  };
};

export const seededDeviceWallet = (
  reserveSponsor = addressOf(Keypair.random()),
) =>
  new DeviceWallet({
    phrase: knownPhrase,
    address: addressOf(signingKey(knownPhrase)),
    username: Schema.decodeSync(Username)("maria"),
    reserveSponsor,
    backup: "stored",
  });

export const sendActors = () => {
  const sponsor = addressOf(Keypair.random());
  const wallet = seededDeviceWallet(sponsor);
  const exchange = addressOf(Keypair.random());
  const pedro = addressOf(Keypair.random());
  const stranger = addressOf(Keypair.random());

  const pedroProfile = new Profile({
    username: Schema.decodeSync(Username)("pedro"),
    address: pedro,
  });

  return {
    wallet,
    sender: wallet.address,
    sponsor,
    exchange,
    pedro,
    stranger,
    pedroProfile,
    payment: (opts: {
      readonly source?: AccountAddress;
      readonly to: AccountAddress;
      readonly amount: PositiveAmount;
      readonly asset?: Asset;
      readonly memo?: PaymentMemo;
      readonly lifetime?: number;
      readonly at?: number;
    }) => {
      const at = opts.at ?? nowSeconds();

      return draftPayment({
        source: new Account(opts.source ?? wallet.address, "100"),
        to: opts.to,
        asset: opts.asset ?? baseAsset,
        amount: opts.amount,
        memo: opts.memo,
        minTime: at,
        maxTime: at + (opts.lifetime ?? 120),
      });
    },
    claimable: (opts: {
      readonly to: AccountAddress;
      readonly amount: PositiveAmount;
      readonly reserveSponsor?: AccountAddress;
    }) => {
      const at = nowSeconds();

      return draftClaimable({
        source: new Account(wallet.address, "100"),
        reserveSponsor: opts.reserveSponsor ?? sponsor,
        to: opts.to,
        asset: baseAsset,
        amount: opts.amount,
        minTime: at,
        maxTime: at + 120,
      });
    },
  };
};

export const transferDraftOf = (
  envelope: UnsignedEnvelope,
  recipient: Profile | ExternalRecipient,
  lifetime = 120,
  at = nowSeconds(),
) =>
  new TransferDraft({
    request: new SigningRequest({
      envelope,
      expiresAt: DateTime.makeUnsafe((at + lifetime) * 1000),
    }),
    recipient,
    memoRequired: false,
  });
