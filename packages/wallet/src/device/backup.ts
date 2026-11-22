import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  type AccountAddress,
  BackupEnrollment,
  type WalletPort,
} from "../contract";
import { DeviceWallet, type KeyStore, PublicDeviceWallet } from "./key-store";
import { UnsupportedDevice } from "./outcomes";
import type { Passkeys } from "./passkeys";
import { backupSalt, sealPhrase } from "./phrase-seal";

export function deviceBackup(
  port: WalletPort,
  passkeys: Passkeys,
  store: KeyStore,
) {
  const rememberBackup = (
    address: AccountAddress,
    backup: NonNullable<DeviceWallet["backup"]>,
  ) =>
    store
      .updatePublic((current) =>
        current.address === address &&
        current.backup !== "stored" &&
        current.backup !== backup
          ? Option.some(new PublicDeviceWallet({ ...current, backup }))
          : Option.none(),
      )
      .pipe(
        Effect.map((result) =>
          Option.isSome(result) &&
          result.value.wallet.address === address &&
          (result.value.wallet.backup === backup ||
            result.value.wallet.backup === "stored")
            ? result.value.wallet
            : new UnsupportedDevice(),
        ),
      );

  const enroll = Effect.fn("Device.enroll")(function* (wallet: DeviceWallet) {
    const challenge = yield* port.passkeyChallenge("enrollment");

    const registered = yield* passkeys.register(
      challenge,
      wallet.username,
      yield* backupSalt,
    );

    if (Option.isNone(registered))
      return yield* rememberBackup(wallet.address, "deviceOnly");

    const step = yield* port.enroll(
      new BackupEnrollment({
        address: wallet.address,
        username: wallet.username,
        registration: registered.value.registration,
        sealed: yield* sealPhrase(registered.value.prf, wallet.phrase),
      }),
    );

    return yield* Match.valueTags(step, {
      BackupStored: () => rememberBackup(wallet.address, "stored"),
      ChallengeRefused: Effect.succeed,
      RegistrationRefused: Effect.succeed,
    });
  });

  return { enroll };
}
