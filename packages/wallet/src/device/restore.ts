import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import {
  AssertionRefused,
  type BackupFound,
  type Profile,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import { network } from "../stellar/network";
import {
  type AssertionCeremony,
  AssertionIntent,
  PinnedCredential,
  type RelyingParty,
  verifyPinnedAssertion,
} from "./assertion";
import {
  type CorruptDeviceWallet,
  KeyStoreUnavailable,
  PublicDeviceWallet,
  SealedDeviceWallet,
  type SealedKeyStore,
} from "./key-store";
import {
  freshInstallationSalt,
  localEnvelopeVersion,
  localPhrasePrfInput,
  reopenLocalEnvelope,
  sealLocalEnvelope,
} from "./local-envelope";
import {
  BackupMismatch,
  BackupUnsupported,
  RestoreOpened,
  type RestoreOutcome,
  RestoreSealed,
  Restored,
  UnsupportedDevice,
  WalletOnDevice,
} from "./outcomes";
import type { PasskeyCancelled, PasskeyFailed, Passkeys } from "./passkeys";
import { backupSalt, openPhrase } from "./phrase-seal";
import type { SecretPhrase } from "./secret-phrase";
import { signingKey } from "./signing";

export interface RestoreDevice {
  readonly store: SealedKeyStore;
  readonly ceremony: AssertionCeremony;
  readonly relyingParty: () => RelyingParty;
}

export type PendingRestore = Data.TaggedEnum<{
  AwaitingSeal: {
    readonly profile: Profile;
    readonly credential: PinnedCredential;
    readonly phrase: Redacted.Redacted<SecretPhrase>;
  };
  AwaitingProof: {
    readonly profile: Profile;
    readonly candidate: SealedDeviceWallet;
  };
}>;

const PendingRestore = Data.taggedEnum<PendingRestore>();

export function deviceRestore(
  port: WalletPort,
  passkeys: Passkeys,
  device: RestoreDevice,
  pending: Ref.Ref<Option.Option<PendingRestore>>,
) {
  const failClosed = <A>(
    effect: Effect.Effect<A, KeyStoreUnavailable | CorruptDeviceWallet>,
  ) =>
    effect.pipe(
      Effect.catchTag("CorruptDeviceWallet", (cause) =>
        Effect.fail(new KeyStoreUnavailable({ cause })),
      ),
    );

  const readDeviceWallet = failClosed(device.store.readSealed());

  const keepBackupOpened = Effect.fn("Device.keepBackupOpened")(function* (
    found: BackupFound,
    assertionId: PinnedCredential["id"],
    prf: Uint8Array<ArrayBuffer>,
  ) {
    const phrase = yield* openPhrase(prf, found.sealed);

    if (
      Option.isNone(phrase) ||
      signingKey(phrase.value).publicKey() !== found.profile.address
    )
      return new BackupMismatch();

    const onDevice = yield* readDeviceWallet;

    if (
      Option.isSome(onDevice) &&
      onDevice.value.public.address !== found.profile.address
    )
      return new BackupMismatch();

    if (Option.isSome(onDevice) && onDevice.value.credential.id === assertionId)
      return new WalletOnDevice();

    yield* Ref.set(
      pending,
      Option.some(
        PendingRestore.AwaitingSeal({
          profile: found.profile,
          credential: new PinnedCredential({
            id: assertionId,
            publicKey: found.publicKey,
            algorithm: found.algorithm,
          }),
          phrase: Redacted.make(phrase.value),
        }),
      ),
    );

    return new RestoreOpened({ profile: found.profile });
  });

  const openBackup = Effect.fn("Device.openBackup")(function* () {
    const challenge = yield* port.passkeyChallenge("restore");

    const authenticated = yield* passkeys.authenticate(
      challenge,
      yield* backupSalt,
    );

    if (Option.isNone(authenticated)) return new BackupUnsupported();

    const step = yield* port.restore(authenticated.value.assertion);

    return yield* Match.valueTags(step, {
      BackupFound: (found) =>
        keepBackupOpened(
          found,
          authenticated.value.assertion.id,
          authenticated.value.prf,
        ),
      NoBackup: Effect.succeed,
      AssertionRefused: Effect.succeed,
      ChallengeRefused: Effect.succeed,
    });
  });

  const sealForDevice = Effect.fn("Device.sealRestoredWallet")(function* (
    waiting: Extract<PendingRestore, { _tag: "AwaitingSeal" }>,
  ) {
    const { profile, credential, phrase } = waiting;
    const salt = freshInstallationSalt();

    const prfInput = yield* localPhrasePrfInput({
      network,
      address: profile.address,
      salt,
    });

    const verified = yield* verifyPinnedAssertion(
      device.ceremony,
      device.relyingParty(),
      credential,
      AssertionIntent.Operation({
        purpose: "restore",
        prf: { first: prfInput, second: Option.none() },
      }),
    );

    return yield* Match.valueTags(verified, {
      OperationVerified: ({ prf }) =>
        sealLocalEnvelope(
          {
            phrase: Redacted.value(phrase),
            network,
            address: profile.address,
            credentialId: credential.id,
            salt,
          },
          prf.first,
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Redacted.value(prf.first).fill(0);
            }),
          ),
          Effect.flatMap(
            Match.valueTags({
              EnvelopeSealed: ({ envelope }) =>
                Ref.set(
                  pending,
                  Option.some(
                    PendingRestore.AwaitingProof({
                      profile,
                      candidate: new SealedDeviceWallet({
                        version: localEnvelopeVersion,
                        public: new PublicDeviceWallet({
                          address: profile.address,
                          username: profile.username,
                          backup: "stored",
                        }),
                        credential,
                        envelope,
                      }),
                    }),
                  ),
                ).pipe(Effect.as(new RestoreSealed({ profile }))),
              CorruptEnvelope: () => Effect.succeed(new UnsupportedDevice()),
            }),
          ),
        ),
      EntryVerified: () => Effect.succeed(new AssertionRefused()),
      WrongCredential: () => Effect.succeed(new AssertionRefused()),
      AssertionRejected: () => Effect.succeed(new AssertionRefused()),
      PrfOutputMissing: () => Effect.succeed(new BackupUnsupported()),
    });
  });

  const proveAndInstall = Effect.fn("Device.proveRestoredWallet")(function* (
    waiting: Extract<PendingRestore, { _tag: "AwaitingProof" }>,
  ) {
    const { profile, candidate } = waiting;

    const reopened = yield* reopenLocalEnvelope(
      device.ceremony,
      device.relyingParty(),
      candidate.credential,
      candidate.envelope,
      { network, address: profile.address, purpose: "restore" },
    );

    return yield* Match.valueTags(reopened, {
      PhraseOpened: () =>
        failClosed(device.store.installSealed(candidate)).pipe(
          Effect.map((installed) =>
            Option.isSome(installed)
              ? new Restored({ profile })
              : new BackupMismatch(),
          ),
        ),
      CorruptEnvelope: () => Effect.succeed(new UnsupportedDevice()),
      WrongCredential: () => Effect.succeed(new AssertionRefused()),
      AssertionRejected: () => Effect.succeed(new AssertionRefused()),
      PrfOutputMissing: () => Effect.succeed(new BackupUnsupported()),
    });
  });

  const restore = Effect.fn("Device.restore")(function* () {
    const waiting = yield* Ref.getAndSet(pending, Option.none());

    const advance: Effect.Effect<
      RestoreOutcome,
      KeyStoreUnavailable | WalletUnavailable | PasskeyCancelled | PasskeyFailed
    > = Option.isNone(waiting)
      ? openBackup()
      : PendingRestore.$match(waiting.value, {
          AwaitingSeal: sealForDevice,
          AwaitingProof: proveAndInstall,
        });

    return yield* advance.pipe(
      Effect.tapErrorTag("PasskeyCancelled", () => Ref.set(pending, waiting)),
    );
  });

  return { restore };
}
