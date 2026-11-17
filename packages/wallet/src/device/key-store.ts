import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, Username } from "../contract";
import { SecretPhrase } from "./secret-phrase";

export class DeviceWallet extends Schema.Class<DeviceWallet>(
  "@workspace/wallet/DeviceWallet",
)({
  phrase: SecretPhrase,
  address: AccountAddress,
  username: Username,
  reserveSponsor: Schema.optional(AccountAddress),
}) {}

export class KeyStoreUnavailable extends Schema.TaggedError<KeyStoreUnavailable>()(
  "KeyStoreUnavailable",
  { cause: Schema.Defect() },
) {}

export interface KeyStore {
  read(): Effect.Effect<Option.Option<DeviceWallet>, KeyStoreUnavailable>;
  write(wallet: DeviceWallet): Effect.Effect<void, KeyStoreUnavailable>;
}
