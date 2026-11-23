import "fake-indexeddb/auto";
import { expect, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AssertionRefused,
  BackupFound,
  ChallengeRefused,
  NoBackup,
  PasskeyChallenge,
  type WalletPort,
} from "../src/contract";
import { PinnedCredential } from "../src/device/assertion";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  BackupLocated,
  BackupMismatch,
  PasskeyCancelled,
  Restored,
  type WalletEffects,
  makeWalletEffects,
} from "../src/device/client";
import { makeEnrollmentEffects } from "../src/device/enrollment";
import {
  PublicDeviceWallet,
  SealedDeviceWallet,
} from "../src/device/key-store";
import {
  LocalPhraseEnvelope,
  freshInstallationSalt,
  localPhrasePrfInput,
  reopenLocalEnvelope,
  sealLocalEnvelope,
} from "../src/device/local-envelope";
import { backupSalt } from "../src/device/phrase-seal";
import { Backups } from "../src/server/Backups.server";
import { backups, passkeyChallenges } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { network } from "../src/stellar/network";
import { memoryKeyStore } from "./device-fixtures";
import {
  clearDatabase,
  enrollDisposableWallet,
  relyingParty,
} from "./sealed-wallet-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";
import {
  passkeyOrigin,
  runAcrossLockWait,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

const restoringDevice = (port: WalletPort, auth: SoftwareAuthenticator) =>
  makeWalletEffects(port, memoryKeyStore(), auth.passkeys, {
    store: browserKeyStore,
    ceremony: auth.assertions,
    relyingParty: () => relyingParty,
  });

const restoreOnFreshTaps = (client: WalletEffects) =>
  Effect.gen(function* () {
    const located = yield* client.restore();
    const restored = yield* client.restore();

    return { located, restored };
  });

const restoredPhrase = (auth: SoftwareAuthenticator) =>
  Effect.gen(function* () {
    const stored = Option.getOrThrow(yield* browserKeyStore.readSealed());

    const reopened = yield* reopenLocalEnvelope(
      auth.assertions,
      relyingParty,
      stored.credential,
      stored.envelope,
      { network, address: stored.public.address, purpose: "approval" },
    );

    assertTagged(reopened, "PhraseOpened");

    return Redacted.value(reopened.phrase);
  });

const backupRows = Effect.gen(function* () {
  const db = yield* Database;

  return yield* db.select().from(backups);
});

const enrollBackedWallet = (
  port: WalletPort,
  auth: SoftwareAuthenticator,
  username: string,
) =>
  Effect.gen(function* () {
    yield* Effect.promise(clearDatabase);

    const enrollment = makeEnrollmentEffects({
      port,
      store: browserKeyStore,
      registration: auth.registration,
      assertions: auth.assertions,
      relyingParty,
    });

    const started = yield* enrollment.start(username);

    assertTagged(started, "EnrollmentPending");

    const completed = yield* enrollment.advance();

    assertTagged(completed, "WalletEnrolled");

    const persisted = Option.getOrThrow(yield* browserKeyStore.readSealed());

    const reopened = yield* reopenLocalEnvelope(
      auth.assertions,
      relyingParty,
      persisted.credential,
      persisted.envelope,
      {
        network,
        address: persisted.public.address,
        purpose: "backup",
      },
    );

    assertTagged(reopened, "PhraseOpened");

    return {
      profile: completed.profile,
      phrase: Redacted.value(reopened.phrase),
    };
  });

const assertion = (
  port: WalletPort,
  auth: SoftwareAuthenticator,
  challenge?: PasskeyChallenge,
) =>
  Effect.gen(function* () {
    const token = challenge ?? (yield* port.passkeyChallenge("restore"));
    const passkey = yield* auth.passkeys.authenticate(token, yield* backupSalt);

    return Option.getOrThrow(passkey).assertion;
  });

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "restore seals the backed phrase to the same credential and refuses a mismatched device or profile address",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const enrolled = yield* enrollBackedWallet(wallet, auth, "maria");
          const phrase = enrolled.phrase;
          const backupRow = (yield* backupRows)[0];

          yield* Effect.promise(clearDatabase);

          const restoring = restoringDevice(wallet, auth);
          const pinnedBeforeRestore = auth.issued.length;
          const steps = yield* restoreOnFreshTaps(restoring);

          expect(auth.issued).toHaveLength(pinnedBeforeRestore + 1);
          expect(steps.located).toBeInstanceOf(BackupLocated);
          expect(
            steps.restored instanceof Restored && steps.restored.profile,
          ).toEqual(enrolled.profile);

          const installed = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(installed.credential.id).toBe(backupRow?.credentialId);
          expect(installed.credential.publicKey).toBe(backupRow?.publicKey);
          expect(installed.public.username).toBe("maria");
          expect(installed.public.backup).toBe("stored");
          expect(yield* restoredPhrase(auth)).toBe(phrase);

          yield* browserKeyStore.writeSealed(
            new SealedDeviceWallet({
              ...installed,
              envelope: new LocalPhraseEnvelope({
                ...installed.envelope,
                ciphertext: Uint8Array.from(
                  installed.envelope.ciphertext,
                  (byte) => byte ^ 1,
                ),
              }),
            }),
          );
          expect(
            (yield* restoreOnFreshTaps(restoring)).restored,
          ).toBeInstanceOf(Restored);
          expect(yield* restoredPhrase(auth)).toBe(phrase);

          const racing = restoringDevice(wallet, auth);
          const started = yield* Effect.forkChild(racing.restore());

          yield* Effect.yieldNow;
          yield* racing.cancelRestore();
          expect(yield* Fiber.join(started)).toBeInstanceOf(BackupLocated);
          expect(yield* racing.restore()).toBeInstanceOf(BackupLocated);

          yield* Effect.promise(clearDatabase);
          const stranger = yield* enrollDisposableWallet("otro");

          yield* browserKeyStore.writeSealed(stranger.record);
          expect(yield* restoringDevice(wallet, auth).restore()).toEqual(
            new BackupMismatch(),
          );
          expect(yield* browserKeyStore.readSealed()).toEqual(
            Option.some(stranger.record),
          );

          yield* Effect.promise(clearDatabase);
          const db = yield* Database;

          yield* db.update(backups).set({ address: stranger.address });

          const tampered = restoringDevice(wallet, auth);

          expect(yield* tampered.restore()).toBeInstanceOf(BackupLocated);
          expect(yield* tampered.restore()).toEqual(new BackupMismatch());
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());
        }),
    );

    it.effect(
      "restore over the same address under another credential replaces the credential only on the sealing tap, which can be cancelled and retried",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const enrolled = yield* enrollBackedWallet(wallet, auth, "maria");
          const phrase = enrolled.phrase;
          const profile = (yield* backupRows)[0];
          const { address, username } = enrolled.profile;

          const oldAuth = new SoftwareAuthenticator(passkeyOrigin);
          const salt = freshInstallationSalt();

          const registered = Option.getOrThrow(
            yield* oldAuth.passkeys.register(
              Schema.decodeSync(PasskeyChallenge)("A".repeat(43)),
              username,
              yield* localPhrasePrfInput({ network, address, salt }),
            ),
          );

          const oldCredential = new PinnedCredential({
            id: registered.registration.id,
            publicKey: registered.registration.publicKey,
            algorithm: "ES256",
          });

          const oldSeal = yield* sealLocalEnvelope(
            {
              phrase,
              network,
              address,
              credentialId: oldCredential.id,
              salt,
            },
            Redacted.make(Uint8Array.from(registered.prf)),
          );

          assertTagged(oldSeal, "EnvelopeSealed");
          yield* browserKeyStore.writeSealed(
            new SealedDeviceWallet({
              version: 2,
              public: new PublicDeviceWallet({ address, username }),
              credential: oldCredential,
              envelope: oldSeal.envelope,
            }),
          );

          const restoring = restoringDevice(wallet, auth);

          yield* restoring.restore();
          auth.cancels = true;
          expect(yield* restoring.restore()).toEqual(new PasskeyCancelled());
          expect(
            Option.getOrThrow(yield* browserKeyStore.readSealed()).credential
              .id,
          ).toBe(oldCredential.id);

          auth.cancels = false;
          expect(yield* restoring.restore()).toBeInstanceOf(Restored);

          const installed = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(installed.credential.id).toBe(profile?.credentialId);
          expect(installed.public.backup).toBe("stored");
          expect(yield* restoredPhrase(auth)).toBe(phrase);
        }),
    );

    it.effect(
      "restore releases a backup only for a fresh restore challenge and its own credential",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);

          yield* enrollBackedWallet(wallet, auth, "maria");
          const fresh = yield* assertion(wallet, auth);

          expect(yield* wallet.restore(fresh)).toBeInstanceOf(BackupFound);
          expect(yield* wallet.restore(fresh)).toEqual(new ChallengeRefused());

          const expiring = yield* assertion(wallet, auth);
          const db = yield* Database;

          yield* db
            .update(passkeyChallenges)
            .set({ expiresAt: new Date(Date.now() - 1000) });
          expect(yield* wallet.restore(expiring)).toEqual(
            new ChallengeRefused(),
          );

          const enrollment = yield* wallet.passkeyChallenge("enrollment");
          const invented = Schema.decodeSync(PasskeyChallenge)("A".repeat(43));

          expect(
            yield* wallet.restore(yield* assertion(wallet, auth, enrollment)),
          ).toEqual(new ChallengeRefused());
          expect(
            yield* wallet.restore(yield* assertion(wallet, auth, invented)),
          ).toEqual(new ChallengeRefused());

          const impostor = new SoftwareAuthenticator(passkeyOrigin);

          impostor.forge(fresh.id);
          expect(
            yield* wallet.restore(yield* assertion(wallet, impostor)),
          ).toEqual(new AssertionRefused());

          const stranger = new SoftwareAuthenticator(passkeyOrigin);

          stranger.forge("c3RyYW5nZXI");
          expect(
            yield* wallet.restore(yield* assertion(wallet, stranger)),
          ).toEqual(new NoBackup());
        }),
    );

    it.effect(
      "consume rejects a challenge that expires while waiting on DELETE",
      () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const { result: consumed } = yield* Effect.gen(function* () {
            yield* TestClock.setTime(now);
            const challenge = yield* Backups.use((s) => s.issue("restore"));

            return yield* runAcrossLockWait({
              locktype: "transactionid",
              advance: "5 minutes",
              acquire: (tx) =>
                tx
                  .select()
                  .from(passkeyChallenges)
                  .where(eq(passkeyChallenges.challenge, challenge))
                  .for("update"),
              run: Backups.use((s) => s.consume(challenge, "restore")),
            });
          }).pipe(Effect.provide(TestClock.layer()));

          expect(consumed).toBe(false);
        }),
    );

    it.effect(
      "issue preserves the full challenge window after cleanup contention",
      () =>
        Effect.gen(function* () {
          const db = yield* Database;
          const stale = Schema.decodeSync(PasskeyChallenge)("B".repeat(43));

          yield* db.insert(passkeyChallenges).values({
            challenge: stale,
            purpose: "restore",
            expiresAt: new Date((yield* Clock.currentTimeMillis) - 1000),
          });

          const { result: issued, now } = yield* runAcrossLockWait({
            locktype: "transactionid",
            advance: "30 seconds",
            acquire: (tx) =>
              tx
                .select()
                .from(passkeyChallenges)
                .where(eq(passkeyChallenges.challenge, stale))
                .for("update"),
            run: Backups.use((s) => s.issue("restore")),
          });

          const consumed = yield* Effect.gen(function* () {
            yield* TestClock.setTime(now + 310_000);

            return yield* Backups.use((s) => s.consume(issued, "restore"));
          }).pipe(Effect.provide(TestClock.layer()));

          expect(consumed).toBe(true);
        }),
    );
  },
);
