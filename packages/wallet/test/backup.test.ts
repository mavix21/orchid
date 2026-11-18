import { expect, layer } from "@effect/vitest";
import { makeDatabase } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  BackupFound,
  BackupStored,
  ChallengeRefused,
  Holding,
  NoBackup,
  Opened,
  PasskeyChallenge,
  RegistrationRefused,
  WalletUnavailable,
  type WalletPort,
} from "../src/contract";
import {
  BackupUnsupported,
  PasskeyCancelled,
  Restored,
  SavedWallet,
  WalletOnDevice,
  makeWalletClient,
} from "../src/device/client";
import type { DeviceWallet, KeyStore } from "../src/device/key-store";
import { backupSalt } from "../src/device/phrase-seal";
import {
  backups,
  passkeyChallenges,
  usernames,
  wallets,
} from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { SoftwareAuthenticator } from "./software-authenticator";
import {
  passkeyOrigin,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

function memoryKeyStore() {
  let saved = Option.none<DeviceWallet>();

  const store: KeyStore = {
    read: () => Effect.sync(() => saved),
    write: (wallet) =>
      Effect.sync(() => {
        saved = Option.some(wallet);
      }),
  };

  return store;
}

const savedWallet = (store: KeyStore) =>
  store.read().pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);

const device = (
  port: WalletPort,
  authenticator: SoftwareAuthenticator,
  store = memoryKeyStore(),
) => ({ store, client: makeWalletClient(port, store, authenticator.passkeys) });

const tableRows = Effect.gen(function* () {
  const db = yield* makeDatabase();

  return {
    backups: yield* db.select().from(backups),
    usernames: yield* db.select().from(usernames),
    wallets: yield* db.select().from(wallets),
  };
});

const assertion = (port: WalletPort, authenticator: SoftwareAuthenticator) =>
  Effect.gen(function* () {
    const challenge = yield* port.passkeyChallenge("restore");

    const passkey = yield* authenticator.passkeys.authenticate(
      challenge,
      yield* backupSalt,
    );

    return Option.getOrThrow(passkey).assertion;
  });

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "creation stores an encrypted backup before the username is claimed",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const authenticator = new SoftwareAuthenticator(passkeyOrigin);
          const calls: Array<string> = [];

          const recording: WalletPort = {
            ...wallet,
            enroll: (enrollment) => {
              calls.push("enroll");

              return wallet.enroll(enrollment);
            },
            open: (claim, approval) => {
              calls.push("open");

              return wallet.open(claim, approval);
            },
          };

          const { store, client } = device(recording, authenticator);

          expect(
            yield* Effect.promise(() => client.create("maria")),
          ).toBeInstanceOf(Opened);

          const saved = yield* savedWallet(store);
          const rows = yield* tableRows;

          expect(calls[0]).toBe("enroll");
          expect(calls.slice(1).every((call) => call === "open")).toBe(true);
          expect(saved.backup).toBe("stored");
          expect(rows.backups).toHaveLength(1);
          expect(rows.backups[0]?.address).toBe(saved.address);
          expect(JSON.stringify(rows.backups)).not.toContain(saved.phrase);
          expect(JSON.stringify(rows.backups)).not.toContain(
            Buffer.from(saved.phrase).toString("base64"),
          );
        }),
    );

    it.effect(
      "a cancelled passkey stops creation, claims nothing and can be retried",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const authenticator = new SoftwareAuthenticator(passkeyOrigin);
          const { store, client } = device(wallet, authenticator);

          authenticator.cancels = true;

          expect(yield* Effect.promise(() => client.create("maria"))).toEqual(
            new PasskeyCancelled(),
          );

          const phrase = (yield* savedWallet(store)).phrase;

          expect(yield* tableRows).toEqual({
            backups: [],
            usernames: [],
            wallets: [],
          });

          authenticator.cancels = false;

          expect(
            yield* Effect.promise(() => client.create("maria")),
          ).toBeInstanceOf(Opened);
          expect((yield* savedWallet(store)).phrase).toBe(phrase);
        }),
    );

    it.effect(
      "a passkey without PRF creates a device-only wallet that can back up later",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const authenticator = new SoftwareAuthenticator(passkeyOrigin);
          const { client } = device(wallet, authenticator);

          authenticator.prf = false;

          const created = yield* Effect.promise(() => client.create("maria"));
          const saved = yield* Effect.promise(() => client.saved());

          expect(created).toBeInstanceOf(Opened);
          expect(saved instanceof SavedWallet && saved.backup).toBe(
            "deviceOnly",
          );
          expect((yield* tableRows).backups).toEqual([]);
          expect(yield* Effect.promise(() => client.backUp())).toEqual(
            new BackupUnsupported(),
          );

          authenticator.prf = true;

          expect(yield* Effect.promise(() => client.backUp())).toEqual(
            new BackupStored(),
          );

          const restored = yield* Effect.promise(() =>
            device(wallet, authenticator).client.restore(),
          );

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
          const authenticator = new SoftwareAuthenticator(passkeyOrigin);
          const first = device(wallet, authenticator);
          const second = device(wallet, authenticator);

          const created = yield* Effect.promise(() =>
            first.client.create("maria"),
          );

          const restored = yield* Effect.promise(() => second.client.restore());

          expect(restored instanceof Restored && restored.profile).toEqual(
            created instanceof Opened && created.profile,
          );
          expect((yield* savedWallet(second.store)).phrase).toBe(
            (yield* savedWallet(first.store)).phrase,
          );
          expect(
            yield* Effect.promise(() => second.client.overview()),
          ).toBeInstanceOf(Holding);

          const before = yield* savedWallet(second.store);

          expect(yield* Effect.promise(() => second.client.restore())).toEqual(
            new WalletOnDevice(),
          );
          expect(yield* savedWallet(second.store)).toEqual(before);
        }),
    );

    it.effect(
      "a wallet backed up before its opening finished restores under the requested name",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const authenticator = new SoftwareAuthenticator(passkeyOrigin);

          const offline: WalletPort = {
            ...wallet,
            open: () =>
              Effect.fail(
                new WalletUnavailable({ cause: new Error("Offline") }),
              ),
          };

          const first = device(offline, authenticator);

          yield* Effect.promise(() => first.client.create("maria"));

          const second = device(wallet, authenticator);
          const restored = yield* Effect.promise(() => second.client.restore());

          expect(
            restored instanceof Restored && restored.profile.username,
          ).toBe("maria");
          expect(
            yield* Effect.promise(() => second.client.create("maria")),
          ).toBeInstanceOf(Opened);
        }),
    );

    it.effect(
      "restore releases a backup only for a fresh restore challenge and its own credential",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const authenticator = new SoftwareAuthenticator(passkeyOrigin);

          yield* Effect.promise(() =>
            device(wallet, authenticator).client.create("maria"),
          );

          const fresh = yield* assertion(wallet, authenticator);

          expect(yield* wallet.restore(fresh)).toBeInstanceOf(BackupFound);
          expect(yield* wallet.restore(fresh)).toEqual(new ChallengeRefused());

          const expiring = yield* assertion(wallet, authenticator);
          const db = yield* makeDatabase();

          yield* db
            .update(passkeyChallenges)
            .set({ expiresAt: new Date(Date.now() - 1000) });

          expect(yield* wallet.restore(expiring)).toEqual(
            new ChallengeRefused(),
          );

          const enrollmentChallenge =
            yield* wallet.passkeyChallenge("enrollment");

          const misused = yield* authenticator.passkeys.authenticate(
            enrollmentChallenge,
            yield* backupSalt,
          );

          expect(
            yield* wallet.restore(Option.getOrThrow(misused).assertion),
          ).toEqual(new ChallengeRefused());

          const invented = yield* authenticator.passkeys.authenticate(
            Schema.decodeSync(PasskeyChallenge)("A".repeat(43)),
            yield* backupSalt,
          );

          expect(
            yield* wallet.restore(Option.getOrThrow(invented).assertion),
          ).toEqual(new ChallengeRefused());

          const impostor = new SoftwareAuthenticator(passkeyOrigin);

          impostor.forge(fresh.id);

          expect(
            yield* wallet.restore(yield* assertion(wallet, impostor)),
          ).toEqual(new NoBackup());

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
        const authenticator = new SoftwareAuthenticator("https://example.com");
        const { client } = device(wallet, authenticator);

        expect(yield* Effect.promise(() => client.create("maria"))).toEqual(
          new RegistrationRefused(),
        );
        expect(yield* tableRows).toEqual({
          backups: [],
          usernames: [],
          wallets: [],
        });

        const db = yield* makeDatabase();

        expect(
          yield* db
            .select()
            .from(passkeyChallenges)
            .where(eq(passkeyChallenges.purpose, "enrollment")),
        ).toEqual([]);
      }),
    );
  },
);
