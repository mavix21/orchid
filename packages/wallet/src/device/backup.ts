import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  BackupEnrollment,
  type BackupFound,
  type WalletPort,
} from "../contract";
import { DeviceWallet, type KeyStore, remember } from "./key-store";
import {
  BackupMismatch,
  BackupUnsupported,
  Restored,
  UnsupportedDevice,
  WalletOnDevice,
} from "./outcomes";
import type { Passkeys } from "./passkeys";
import { backupSalt, openPhrase, sealPhrase } from "./phrase-seal";
import { signingKey } from "./signing";

export function deviceBackup(
  port: WalletPort,
  passkeys: Passkeys,
  store: KeyStore,
) {
  const rememberBackup = (
    wallet: DeviceWallet,
    backup: DeviceWallet["backup"],
  ) =>
    remember(store, new DeviceWallet({ ...wallet, backup })).pipe(
      Effect.map(
        Option.match({
          onNone: () => new UnsupportedDevice(),
          onSome: (remembered) => remembered,
        }),
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
      return yield* rememberBackup(wallet, "deviceOnly");

    const step = yield* port.enroll(
      new BackupEnrollment({
        address: wallet.address,
        username: wallet.username,
        registration: registered.value.registration,
        sealed: yield* sealPhrase(registered.value.prf, wallet.phrase),
      }),
    );

    return yield* Match.valueTags(step, {
      BackupStored: () => rememberBackup(wallet, "stored"),
      ChallengeRefused: Effect.succeed,
      RegistrationRefused: Effect.succeed,
    });
  });

  const keepRestored = Effect.fn("Device.keepRestored")(function* (
    found: BackupFound,
    prf: Uint8Array<ArrayBuffer>,
  ) {
    const phrase = yield* openPhrase(prf, found.sealed);

    if (
      Option.isNone(phrase) ||
      signingKey(phrase.value).publicKey() !== found.profile.address
    )
      return new BackupMismatch();

    if (Option.isSome(yield* store.read())) return new WalletOnDevice();

    const restored = yield* remember(
      store,
      new DeviceWallet({
        phrase: phrase.value,
        address: found.profile.address,
        username: found.profile.username,
        backup: "stored",
      }),
    );

    return Option.isSome(restored)
      ? new Restored({ profile: found.profile })
      : new UnsupportedDevice();
  });

  const restore = Effect.fn("Device.restore")(function* () {
    if (Option.isSome(yield* store.read())) return new WalletOnDevice();

    const challenge = yield* port.passkeyChallenge("restore");

    const authenticated = yield* passkeys.authenticate(
      challenge,
      yield* backupSalt,
    );

    if (Option.isNone(authenticated)) return new BackupUnsupported();

    const step = yield* port.restore(authenticated.value.assertion);

    return yield* Match.valueTags(step, {
      BackupFound: (found) => keepRestored(found, authenticated.value.prf),
      NoBackup: Effect.succeed,
      AssertionRefused: Effect.succeed,
      ChallengeRefused: Effect.succeed,
    });
  });

  return { enroll, restore };
}
