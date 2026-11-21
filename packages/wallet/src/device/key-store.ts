import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  PaymentLinkReceipt,
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

export interface KeyStore {
  read(): Effect.Effect<Option.Option<DeviceWallet>, KeyStoreUnavailable>;
  write(wallet: DeviceWallet): Effect.Effect<void, KeyStoreUnavailable>;
}

const receiptJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(PaymentLinkReceipt)),
);

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
