import { expect, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AccountAddress,
  AssertionRefused,
  BackupFound,
  BackupStored,
  ChallengeRefused,
  NoBackup,
  Offline,
  Opened,
  PasskeyChallenge,
  RegistrationRefused,
  Username,
  type WalletPort,
} from "../src/contract";
import { PinnedCredential } from "../src/device/assertion";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  BackupMismatch,
  BackupUnsupported,
  PasskeyCancelled,
  RestoreOpened,
  RestoreSealed,
  Restored,
  SavedWallet,
  WalletOnDevice,
  type WalletEffects,
  makeWalletEffects,
} from "../src/device/client";
import {
  PublicDeviceWallet,
  SealedDeviceWallet,
} from "../src/device/key-store";
import {
  localPhrasePrfInput,
  reopenLocalEnvelope,
  sealLocalEnvelope,
  freshInstallationSalt,
} from "../src/device/local-envelope";
import { backupSalt } from "../src/device/phrase-seal";
import { signingKey } from "../src/device/signing";
import { Backups } from "../src/server/Backups.server";
import {
  backups,
  passkeyChallenges,
  usernames,
  wallets,
} from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { network } from "../src/stellar/network";
import { memoryKeyStore, savedWallet } from "./device-fixtures";
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

const device = (
  port: WalletPort,
  auth: SoftwareAuthenticator,
  store = memoryKeyStore(),
) => ({
  store,
  client: makeWalletEffects(port, store, auth.passkeys),
});

const restoringDevice = (port: WalletPort, auth: SoftwareAuthenticator) =>
  makeWalletEffects(port, memoryKeyStore(), auth.passkeys, {
    store: browserKeyStore,
    ceremony: auth.assertions,
    relyingParty: () => relyingParty,
  });

const restoreOnFreshTaps = (client: WalletEffects) =>
  Effect.gen(function* () {
    const opened = yield* client.restore();
    const sealed = yield* client.restore();
    const restored = yield* client.restore();

    return { opened, sealed, restored };
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

const tableRows = Effect.gen(function* () {
  const db = yield* Database;

  return {
    backups: yield* db.select().from(backups),
    usernames: yield* db.select().from(usernames),
    wallets: yield* db.select().from(wallets),
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
      "creation stores an encrypted backup before opening and restores under the requested name",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);

          const offlinePort: WalletPort = {
            ...wallet,
            open: () => Effect.fail(new Offline()),
          };

          const first = device(offlinePort, auth);

          yield* first.client.create("maria");
          const saved = yield* savedWallet(first.store);
          const rows = yield* tableRows;

          expect(saved.address).toBe(signingKey(saved.phrase).publicKey());
          expect(saved.backup).toBe("stored");
          expect(rows.backups).toHaveLength(1);
          expect(rows.backups[0]?.address).toBe(saved.address);
          expect(JSON.stringify(rows.backups)).not.toContain(saved.phrase);
          expect(JSON.stringify(rows.backups)).not.toContain(
            Buffer.from(saved.phrase).toString("base64"),
          );

          yield* Effect.promise(clearDatabase);

          const { restored } = yield* restoreOnFreshTaps(
            restoringDevice(wallet, auth),
          );

          expect(
            restored instanceof Restored && restored.profile.username,
          ).toBe("maria");
        }),
    );

    it.effect(
      "a cancelled passkey stops creation, claims nothing and can be retried",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const { store, client } = device(wallet, auth);

          auth.cancels = true;
          expect(yield* client.create("maria")).toEqual(new PasskeyCancelled());
          const phrase = (yield* savedWallet(store)).phrase;

          expect(yield* tableRows).toEqual({
            backups: [],
            usernames: [],
            wallets: [],
          });

          auth.cancels = false;
          expect(yield* client.create("maria")).toBeInstanceOf(Opened);
          expect((yield* savedWallet(store)).phrase).toBe(phrase);
        }),
    );

    it.effect(
      "a passkey without PRF creates a device-only wallet that can back up later",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const { client } = device(wallet, auth);

          auth.prf = false;
          const created = yield* client.create("maria");
          const saved = yield* client.saved();

          expect(created).toBeInstanceOf(Opened);
          expect(saved instanceof SavedWallet && saved.backup).toBe(
            "deviceOnly",
          );
          expect((yield* tableRows).backups).toEqual([]);
          expect(yield* client.backUp()).toEqual(new BackupUnsupported());

          auth.prf = true;
          expect(yield* client.backUp()).toEqual(new BackupStored());
          yield* Effect.promise(clearDatabase);

          const { restored } = yield* restoreOnFreshTaps(
            restoringDevice(wallet, auth),
          );

          expect(restored instanceof Restored && restored.profile).toEqual(
            created instanceof Opened && created.profile,
          );
        }),
    );

    it.effect(
      "restore seals the backed phrase to the same credential and refuses a mismatched device or profile address",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const first = device(wallet, auth);
          const created = yield* first.client.create("maria");
          const phrase = (yield* savedWallet(first.store)).phrase;
          const backupRow = (yield* tableRows).backups[0];

          const restoring = restoringDevice(wallet, auth);
          const steps = yield* restoreOnFreshTaps(restoring);

          expect(steps.opened).toBeInstanceOf(RestoreOpened);
          expect(steps.sealed).toBeInstanceOf(RestoreSealed);
          expect(
            steps.restored instanceof Restored && steps.restored.profile,
          ).toEqual(created instanceof Opened && created.profile);

          const installed = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(installed.credential.id).toBe(backupRow?.credentialId);
          expect(installed.credential.publicKey).toBe(backupRow?.publicKey);
          expect(installed.public.username).toBe("maria");
          expect(installed.public.backup).toBe("stored");
          expect(yield* restoredPhrase(auth)).toBe(phrase);
          expect(yield* restoring.restore()).toEqual(new WalletOnDevice());
          expect(yield* browserKeyStore.readSealed()).toEqual(
            Option.some(installed),
          );

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
          expect(yield* restoringDevice(wallet, auth).restore()).toEqual(
            new BackupMismatch(),
          );
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());
        }),
    );

    it.effect(
      "restore over the same address under another credential keeps the device's public state and a cancelled proof installs nothing",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const first = device(wallet, auth);

          yield* first.client.create("maria");
          const phrase = (yield* savedWallet(first.store)).phrase;
          const profile = (yield* tableRows).backups[0];

          const address = Schema.decodeSync(AccountAddress)(
            profile?.address ?? "",
          );

          const username = Schema.decodeSync(Username)("maria");

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
              public: new PublicDeviceWallet({
                address,
                username,
                reserveSponsor: address,
              }),
              credential: oldCredential,
              envelope: oldSeal.envelope,
            }),
          );

          const restoring = restoringDevice(wallet, auth);

          yield* restoring.restore();
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
          expect(installed.public.reserveSponsor).toBe(address);
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

          yield* device(wallet, auth).client.create("maria");
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

    it.effect("a registration from an unlisted origin stores no backup", () =>
      Effect.gen(function* () {
        const wallet = yield* Wallet;
        const unlisted = new SoftwareAuthenticator("https://example.com");
        const { client } = device(wallet, unlisted);

        expect(yield* client.create("maria")).toEqual(
          new RegistrationRefused(),
        );
        expect(yield* tableRows).toEqual({
          backups: [],
          usernames: [],
          wallets: [],
        });

        const db = yield* Database;

        expect(
          yield* db
            .select()
            .from(passkeyChallenges)
            .where(eq(passkeyChallenges.purpose, "enrollment")),
        ).toEqual([]);
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
