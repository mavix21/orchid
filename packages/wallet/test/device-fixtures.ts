import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  AccountAddress,
  type Asset,
  type BalanceId,
  type DestinationAddress,
  type ExternalRecipient,
  type LinkRecipient,
  MuxedAddress,
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
import {
  type KeyStore,
  KeyStoreUnavailable,
  PublicDeviceWallet,
} from "../src/device/key-store";
import {
  SecretPhrase,
  generateSecretPhrase,
} from "../src/device/secret-phrase";
import { generateLinkCode, linkKeyOf } from "../src/device/link-code";
import { signingKey } from "../src/device/signing";
import {
  draftClaimable,
  draftPaymentLink,
} from "../src/stellar/asset-envelopes";
import { draftPayment } from "../src/stellar/envelopes";

export const linkFixture = () => {
  const code = generateLinkCode();

  return {
    code,
    keypair: Keypair.fromSecret(Option.getOrThrow(linkKeyOf(code)).secret),
  };
};

export const addressOf = (key: Keypair) =>
  Schema.decodeSync(AccountAddress)(key.publicKey());

export const knownPhrase = Schema.decodeSync(SecretPhrase)(
  "illness spike retreat truth genius clock brain pass fit cave bargain toe",
);

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export class DeviceWallet extends PublicDeviceWallet.extend<DeviceWallet>(
  "@workspace/wallet/test/DeviceWallet",
)({
  phrase: SecretPhrase,
}) {}

export const publicWalletOf = (wallet: DeviceWallet) =>
  new PublicDeviceWallet({
    address: wallet.address,
    username: wallet.username,
    reserveSponsor: wallet.reserveSponsor,
    backup: wallet.backup,
    transfer: wallet.transfer,
    approvedUntil: wallet.approvedUntil,
    linkReceipt: wallet.linkReceipt,
    transferRevision: wallet.transferRevision,
  });

export interface MemoryKeyStore extends KeyStore {
  seed(wallet: DeviceWallet): Effect.Effect<void>;
}

export function memoryKeyStore(
  initial = Option.none<DeviceWallet>(),
): MemoryKeyStore {
  let saved = Option.map(initial, publicWalletOf);
  const lock = Semaphore.makeUnsafe(1);

  return {
    seed: (wallet) =>
      lock.withPermit(
        Effect.sync(() => {
          saved = Option.some(publicWalletOf(wallet));
        }),
      ),
    readPublic: () => Effect.sync(() => saved),
    updatePublic: (update) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (Option.isNone(saved)) return Option.none();

          const current = saved.value;
          const next = update(current);

          if (Option.isNone(next))
            return Option.some({ wallet: current, updated: false });

          if (next.value.address !== current.address)
            return yield* new KeyStoreUnavailable({
              cause: new Error("Wallet address cannot change"),
            });

          saved = next;

          return Option.some({ wallet: next.value, updated: true });
        }),
      ),
  };
}

export const savedWallet = (store: KeyStore) =>
  store.readPublic().pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);

export const unusedPort = (overrides: Partial<WalletPort> = {}): WalletPort => {
  const unused = () => Effect.die("Not used by test");

  return {
    overview: unused,
    open: unused,
    transfer: unused,
    manage: unused,
    paymentLinks: unused,
    paymentLink: unused,
    claimPaymentLink: unused,
    resolvePaymentLink: unused,
    passkeyChallenge: unused,
    enroll: unused,
    restore: unused,
    ...overrides,
  };
};

export const enrolledDeviceWallet = (name = "maria") => {
  const phrase = generateSecretPhrase();

  return new DeviceWallet({
    phrase,
    address: addressOf(signingKey(phrase)),
    username: Schema.decodeSync(Username)(name),
    backup: "stored",
  });
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
    muxed: (id: string) =>
      Schema.decodeSync(MuxedAddress)(
        new MuxedAccount(new Account(exchange, "0"), id).accountId(),
      ),
    payment: (opts: {
      readonly source?: AccountAddress;
      readonly to: DestinationAddress;
      readonly amount: PositiveAmount;
      readonly asset?: Asset;
      readonly memo?: PaymentMemo;
      readonly sequence?: string;
      readonly lifetime?: number;
      readonly at?: number;
    }) => {
      const at = opts.at ?? nowSeconds();

      return draftPayment({
        source: new Account(
          opts.source ?? wallet.address,
          opts.sequence ?? "100",
        ),
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
    paymentLink: (opts: {
      readonly source?: AccountAddress;
      readonly to: AccountAddress;
      readonly asset?: Asset;
      readonly amount: PositiveAmount;
      readonly reserveSponsor?: AccountAddress;
      readonly sequence?: string;
      readonly lifetime?: number;
      readonly at?: number;
    }) => {
      const at = opts.at ?? nowSeconds();

      return draftPaymentLink({
        source: new Account(
          opts.source ?? wallet.address,
          opts.sequence ?? "100",
        ),
        reserveSponsor: opts.reserveSponsor ?? sponsor,
        to: opts.to,
        asset: opts.asset ?? baseAsset,
        amount: opts.amount,
        minTime: at,
        maxTime: at + (opts.lifetime ?? 120),
      });
    },
  };
};

export const transferDraftOf = (
  envelope: UnsignedEnvelope,
  recipient: Profile | LinkRecipient | ExternalRecipient,
  lifetime = 120,
  at = nowSeconds(),
  claimable?: BalanceId,
) =>
  new TransferDraft({
    request: new SigningRequest({
      envelope,
      expiresAt: DateTime.makeUnsafe((at + lifetime) * 1000),
    }),
    recipient,
    memoRequired: false,
    claimable,
  });
