import "fake-indexeddb/auto";
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
  AssertionRefused,
  BackupFound,
  ChallengeRefused,
  NoBackup,
  Opened,
  PasskeyChallenge,
  type WalletPort,
} from "../src/contract";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  Restored,
  WalletOnDevice,
  makeWalletEffects,
} from "../src/device/client";
import { makeEnrollmentEffects } from "../src/device/enrollment";
import { reopenLocalEnvelope } from "../src/device/local-envelope";
import { backupSalt } from "../src/device/phrase-seal";
import { Backups } from "../src/server/Backups.server";
import { passkeyChallenges } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { network } from "../src/stellar/network";
import { memoryKeyStore, savedWallet } from "./device-fixtures";
import { clearDatabase, relyingParty } from "./sealed-wallet-fixtures";
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
      "another device restores the enrolled secret phrase and username without overwriting",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const enrolled = yield* enrollBackedWallet(wallet, auth, "maria");
          const second = device(wallet, auth);
          const restored = yield* second.client.restore();

          expect(restored instanceof Restored && restored.profile).toEqual(
            enrolled.profile,
          );
          expect((yield* savedWallet(second.store)).phrase).toBe(
            enrolled.phrase,
          );
          expect(yield* second.client.create("maria")).toBeInstanceOf(Opened);

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
