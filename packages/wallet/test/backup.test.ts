import { expect, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AssertionRefused,
  BackupFound,
  BackupStored,
  ChallengeRefused,
  NoBackup,
  Offline,
  Opened,
  PasskeyChallenge,
  RegistrationRefused,
  type WalletPort,
} from "../src/contract";
import {
  BackupUnsupported,
  PasskeyCancelled,
  Restored,
  SavedWallet,
  WalletOnDevice,
  makeWalletEffects,
} from "../src/device/client";
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
import { memoryKeyStore, savedWallet } from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
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

          const second = device(wallet, auth);
          const restored = yield* second.client.restore();

          expect(
            restored instanceof Restored && restored.profile.username,
          ).toBe("maria");
          expect(yield* second.client.create("maria")).toBeInstanceOf(Opened);
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
          const restored = yield* device(wallet, auth).client.restore();

          expect(restored instanceof Restored && restored.profile).toEqual(
            created instanceof Opened && created.profile,
          );
        }),
    );

    it.effect(
      "another device restores the same secret phrase and username without overwriting",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const first = device(wallet, auth);
          const second = device(wallet, auth);
          const created = yield* first.client.create("maria");
          const restored = yield* second.client.restore();

          expect(restored instanceof Restored && restored.profile).toEqual(
            created instanceof Opened && created.profile,
          );
          expect((yield* savedWallet(second.store)).phrase).toBe(
            (yield* savedWallet(first.store)).phrase,
          );

          const before = yield* savedWallet(second.store);

          expect(yield* second.client.restore()).toEqual(new WalletOnDevice());
          expect(yield* savedWallet(second.store)).toEqual(before);
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
