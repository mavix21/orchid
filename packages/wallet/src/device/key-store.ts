import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, Username } from "../contract";
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
}) {}

export class KeyStoreUnavailable extends Schema.TaggedError<KeyStoreUnavailable>()(
  "KeyStoreUnavailable",
  { cause: Schema.Defect() },
) {}

export interface KeyStore {
  read(): Effect.Effect<Option.Option<DeviceWallet>, KeyStoreUnavailable>;
  write(wallet: DeviceWallet): Effect.Effect<void, KeyStoreUnavailable>;
}

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
    stored.value.backup === wallet.backup
    ? Option.some(stored.value)
    : Option.none();
});
