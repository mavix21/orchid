import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  PaymentLinkReceipt,
  type TransferId,
  TransferOrder,
  Username,
} from "../contract";
import { PinnedCredential } from "./assertion";
import { LocalPhraseEnvelope, localEnvelopeVersion } from "./local-envelope";
import { SecretPhrase } from "./secret-phrase";

export const BackupState = Schema.Literals(["stored"]);

const publicWalletFields = {
  address: AccountAddress,
  username: Username,
  reserveSponsor: Schema.optional(AccountAddress),
  backup: Schema.optional(BackupState),
  transfer: Schema.optional(TransferOrder),
  approvedUntil: Schema.optional(Schema.Number),
  linkReceipt: Schema.optional(PaymentLinkReceipt),
  transferRevision: Schema.optional(Schema.Number),
};

export class PublicDeviceWallet extends Schema.Class<PublicDeviceWallet>(
  "@workspace/wallet/PublicDeviceWallet",
)(publicWalletFields) {}

export class DeviceWallet extends Schema.Class<DeviceWallet>(
  "@workspace/wallet/DeviceWallet",
)({
  ...publicWalletFields,
  phrase: SecretPhrase,
}) {}

export class SealedDeviceWallet extends Schema.Class<SealedDeviceWallet>(
  "@workspace/wallet/SealedDeviceWallet",
)({
  version: Schema.Literal(localEnvelopeVersion),
  public: PublicDeviceWallet,
  credential: PinnedCredential,
  envelope: LocalPhraseEnvelope,
}) {}

export const publicWalletOf = (
  wallet: PublicDeviceWallet | DeviceWallet,
): PublicDeviceWallet =>
  wallet instanceof PublicDeviceWallet
    ? wallet
    : new PublicDeviceWallet({
        address: wallet.address,
        username: wallet.username,
        reserveSponsor: wallet.reserveSponsor,
        backup: wallet.backup,
        transfer: wallet.transfer,
        approvedUntil: wallet.approvedUntil,
        linkReceipt: wallet.linkReceipt,
        transferRevision: wallet.transferRevision,
      });

export class KeyStoreUnavailable extends Schema.TaggedError<KeyStoreUnavailable>()(
  "KeyStoreUnavailable",
  { cause: Schema.Defect() },
) {}

export class CorruptDeviceWallet extends Schema.TaggedError<CorruptDeviceWallet>()(
  "CorruptDeviceWallet",
  {},
) {}

export interface LinkClearTarget {
  readonly address: AccountAddress;
  readonly transferId: TransferId | undefined;
  readonly approvedUntil: number | undefined;
  readonly receipt: PaymentLinkReceipt;
}

export interface PublicWalletUpdate {
  readonly wallet: PublicDeviceWallet;
  readonly updated: boolean;
}

export interface SealedKeyStore {
  readPublic(): Effect.Effect<
    Option.Option<PublicDeviceWallet>,
    KeyStoreUnavailable | CorruptDeviceWallet
  >;
  updatePublic(
    update: (current: PublicDeviceWallet) => Option.Option<PublicDeviceWallet>,
  ): Effect.Effect<
    Option.Option<PublicWalletUpdate>,
    KeyStoreUnavailable | CorruptDeviceWallet
  >;
  readSealed(): Effect.Effect<
    Option.Option<SealedDeviceWallet>,
    KeyStoreUnavailable | CorruptDeviceWallet
  >;
  writeSealed(
    wallet: SealedDeviceWallet,
  ): Effect.Effect<void, KeyStoreUnavailable>;
  installSealed(
    wallet: SealedDeviceWallet,
  ): Effect.Effect<boolean, KeyStoreUnavailable | CorruptDeviceWallet>;
}

export interface KeyStore {
  read(): Effect.Effect<Option.Option<DeviceWallet>, KeyStoreUnavailable>;
  write(wallet: DeviceWallet): Effect.Effect<void, KeyStoreUnavailable>;
  readPublic(): Effect.Effect<
    Option.Option<PublicDeviceWallet>,
    KeyStoreUnavailable
  >;
  updatePublic(
    update: (current: PublicDeviceWallet) => Option.Option<PublicDeviceWallet>,
  ): Effect.Effect<Option.Option<PublicWalletUpdate>, KeyStoreUnavailable>;
}

export const receiptJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(PaymentLinkReceipt)),
);

export const sameLinkState = (
  wallet: Pick<
    PublicDeviceWallet,
    "address" | "transfer" | "approvedUntil" | "linkReceipt"
  >,
  expected: LinkClearTarget,
) =>
  wallet.address === expected.address &&
  wallet.transfer?.id === expected.transferId &&
  wallet.approvedUntil === expected.approvedUntil &&
  receiptJson(wallet.linkReceipt ?? null) === receiptJson(expected.receipt);

export const clearStoredLink = Effect.fn("Device.clearStoredLink")(function* <
  E,
>(
  store: {
    updatePublic(
      update: (
        current: PublicDeviceWallet,
      ) => Option.Option<PublicDeviceWallet>,
    ): Effect.Effect<Option.Option<PublicWalletUpdate>, E>;
  },
  expected: LinkClearTarget,
) {
  yield* store.updatePublic((current) =>
    sameLinkState(current, expected)
      ? Option.some(
          new PublicDeviceWallet({
            ...current,
            transfer: undefined,
            approvedUntil: undefined,
            linkReceipt: undefined,
            transferRevision: (current.transferRevision ?? 0) + 1,
          }),
        )
      : Option.none(),
  );
});

export const remember = Effect.fn("Device.remember")(function* (
  store: KeyStore,
  wallet: DeviceWallet,
) {
  yield* store.write(wallet);

  const stored = yield* store.read();

  return Option.isSome(stored) &&
    stored.value.phrase === wallet.phrase &&
    stored.value.address === wallet.address &&
    stored.value.username === wallet.username &&
    stored.value.reserveSponsor === wallet.reserveSponsor &&
    stored.value.backup === wallet.backup &&
    stored.value.transfer?.id === wallet.transfer?.id &&
    stored.value.approvedUntil === wallet.approvedUntil &&
    stored.value.transferRevision === wallet.transferRevision &&
    receiptJson(stored.value.linkReceipt ?? null) ===
      receiptJson(wallet.linkReceipt ?? null)
    ? Option.some(stored.value)
    : Option.none();
});
