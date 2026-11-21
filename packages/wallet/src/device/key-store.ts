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
import { SecretPhrase } from "./secret-phrase";

export const BackupState = Schema.Literals(["stored", "deviceOnly"]);

export class DeviceWallet extends Schema.Class<DeviceWallet>(
  "@workspace/wallet/DeviceWallet",
)({
  phrase: SecretPhrase,
  address: AccountAddress,
  username: Username,
  reserveSponsor: Schema.optional(AccountAddress),
  backup: Schema.optional(BackupState),
  transfer: Schema.optional(TransferOrder),
  approvedUntil: Schema.optional(Schema.Number),
  linkReceipt: Schema.optional(PaymentLinkReceipt),
}) {}

export class KeyStoreUnavailable extends Schema.TaggedError<KeyStoreUnavailable>()(
  "KeyStoreUnavailable",
  { cause: Schema.Defect() },
) {}

export interface LinkClearTarget {
  readonly address: AccountAddress;
  readonly transferId: TransferId | undefined;
  readonly approvedUntil: number | undefined;
  readonly receipt: PaymentLinkReceipt;
}

export interface KeyStore {
  read(): Effect.Effect<Option.Option<DeviceWallet>, KeyStoreUnavailable>;
  write(wallet: DeviceWallet): Effect.Effect<void, KeyStoreUnavailable>;
  clearLink?(
    expected: LinkClearTarget,
  ): Effect.Effect<void, KeyStoreUnavailable>;
}

export const receiptJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(PaymentLinkReceipt)),
);

export const sameLinkState = (
  wallet: Pick<
    DeviceWallet,
    "address" | "transfer" | "approvedUntil" | "linkReceipt"
  >,
  expected: LinkClearTarget,
) =>
  wallet.address === expected.address &&
  wallet.transfer?.id === expected.transferId &&
  wallet.approvedUntil === expected.approvedUntil &&
  receiptJson(wallet.linkReceipt ?? null) === receiptJson(expected.receipt);

export const clearStoredLink = Effect.fn("Device.clearStoredLink")(function* (
  store: KeyStore,
  expected: LinkClearTarget,
) {
  if (store.clearLink) return yield* store.clearLink(expected);

  const current = yield* store.read();

  if (Option.isSome(current) && sameLinkState(current.value, expected))
    yield* store.write(
      new DeviceWallet({
        ...current.value,
        transfer: undefined,
        approvedUntil: undefined,
        linkReceipt: undefined,
      }),
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
    receiptJson(stored.value.linkReceipt ?? null) ===
      receiptJson(wallet.linkReceipt ?? null)
    ? Option.some(stored.value)
    : Option.none();
});
