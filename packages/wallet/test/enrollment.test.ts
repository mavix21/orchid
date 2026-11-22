import "fake-indexeddb/auto";
import { expect, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  BackupEnrollment,
  BackupFound,
  Offline,
  Username,
  type WalletPort,
} from "../src/contract";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  EnrollmentPending,
  type PendingEnrollmentRecord,
  type PendingEnrollmentStorage,
  PendingReopenProof,
  makeEnrollmentEffects,
} from "../src/device/enrollment";
import { KeyStoreUnavailable } from "../src/device/key-store";
import {
  LocalPhraseEnvelope,
  localEnvelopeVersion,
  reopenLocalEnvelope,
} from "../src/device/local-envelope";
import { backupSalt, openPhrase } from "../src/device/phrase-seal";
import { signingKey } from "../src/device/signing";
import { backups, usernames, wallets } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { network } from "../src/stellar/network";
import { clearDatabase, relyingParty } from "./sealed-wallet-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";
import {
  passkeyOrigin,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

const memoryPendingStorage = (): PendingEnrollmentStorage & {
  readSync(): Option.Option<PendingEnrollmentRecord>;
  replaceSync(record: PendingEnrollmentRecord): void;
} => {
  let saved = Option.none<PendingEnrollmentRecord>();

  return {
    read: () => Effect.sync(() => saved),
    write: (record) =>
      Effect.sync(() => {
        saved = Option.some(record);
      }),
    clear: () =>
      Effect.sync(() => {
        saved = Option.none();
      }),
    readSync: () => saved,
    replaceSync: (record) => {
      saved = Option.some(record);
    },
  };
};

const enrollmentFor = (
  port: WalletPort,
  auth: SoftwareAuthenticator,
  pending?: PendingEnrollmentStorage,
) =>
  makeEnrollmentEffects({
    port,
    store: browserKeyStore,
    registration: auth.registration,
    assertions: auth.assertions,
    relyingParty,
    pending,
  });

const tableRows = Effect.gen(function* () {
  const db = yield* Database;

  return {
    backups: yield* db.select().from(backups),
    usernames: yield* db.select().from(usernames),
    wallets: yield* db.select().from(wallets),
  };
});

const restoreBackupPhrase = (port: WalletPort, auth: SoftwareAuthenticator) =>
  Effect.gen(function* () {
    const challenge = yield* port.passkeyChallenge("restore");

    const authenticated = Option.getOrThrow(
      yield* auth.passkeys.authenticate(challenge, yield* backupSalt),
    );

    const restored = yield* port.restore(authenticated.assertion);

    expect(restored).toBeInstanceOf(BackupFound);

    if (!(restored instanceof BackupFound))
      throw new Error("Expected BackupFound");

    return {
      profile: restored.profile,
      phrase: Option.getOrThrow(
        yield* openPhrase(authenticated.prf, restored.sealed),
      ),
    };
  });

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "requires a distinct reopen proof before activating a wallet, recovers interrupted proof, and stores a compatible backup",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const pending = memoryPendingStorage();

          const firstTab = enrollmentFor(wallet, auth, pending);

          const started = yield* firstTab.start("maria");

          expect(started).toEqual(
            new EnrollmentPending({
              stage: "reopen",
              username: Schema.decodeSync(Username)("maria"),
            }),
          );
          expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());

          const beforeProof = yield* tableRows;

          expect(beforeProof.backups).toHaveLength(1);
          expect(beforeProof.usernames).toEqual([]);
          expect(beforeProof.wallets).toEqual([]);

          auth.cancels = true;
          expect((yield* firstTab.advance())._tag).toBe("PasskeyCancelled");
          expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());
          expect(yield* firstTab.pending()).toEqual(Option.some(started));

          auth.cancels = false;

          const reloadedTab = enrollmentFor(wallet, auth, pending);

          expect(yield* reloadedTab.pending()).toEqual(Option.some(started));
          expect(yield* reloadedTab.start("pedro")).toEqual(started);

          const completed = yield* reloadedTab.advance();

          assertTagged(completed, "WalletEnrolled");
          expect(completed.profile.username).toBe("maria");
          expect(yield* reloadedTab.pending()).toEqual(Option.none());
          expect(pending.readSync()).toEqual(Option.none());

          const persisted = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(persisted.version).toBe(localEnvelopeVersion);
          expect(persisted.public.address).toBe(completed.profile.address);
          expect(persisted.public.username).toBe("maria");
          expect(persisted.public.backup).toBe("stored");
          expect(persisted.credential.id).toBe(auth.registered[0]?.id);

          const reopened = yield* reopenLocalEnvelope(
            auth.assertions,
            relyingParty,
            persisted.credential,
            persisted.envelope,
            {
              network,
              address: persisted.public.address,
              purpose: "approval",
            },
          );

          assertTagged(reopened, "PhraseOpened");

          const localPhrase = Redacted.value(reopened.phrase);
          const restoredBackup = yield* restoreBackupPhrase(wallet, auth);

          expect(signingKey(localPhrase).publicKey()).toBe(
            completed.profile.address,
          );
          expect(restoredBackup.phrase).toBe(localPhrase);
          expect(restoredBackup.profile).toEqual(completed.profile);
          expect((yield* tableRows).usernames).toEqual([]);
          expect((yield* tableRows).wallets).toEqual([]);

          expect((yield* reloadedTab.start("pedro"))._tag).toBe(
            "WalletOnDevice",
          );
          expect(yield* browserKeyStore.readSealed()).toEqual(
            Option.some(persisted),
          );
        }),
    );

    it.effect(
      "installs only one wallet when two tabs complete reopen proof concurrently",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = yield* Wallet;
          const firstAuth = new SoftwareAuthenticator(passkeyOrigin);
          const secondAuth = new SoftwareAuthenticator(passkeyOrigin);

          const firstTab = enrollmentFor(wallet, firstAuth);
          const secondTab = enrollmentFor(wallet, secondAuth);

          assertTagged(yield* firstTab.start("maria"), "EnrollmentPending");
          assertTagged(yield* secondTab.start("pedro"), "EnrollmentPending");

          const [firstOutcome, secondOutcome] = yield* Effect.all(
            [firstTab.advance(), secondTab.advance()],
            { concurrency: "unbounded" },
          );

          const outcomes = [firstOutcome, secondOutcome];

          const winner = Option.getOrThrow(
            Option.fromNullishOr(
              outcomes.find(Predicate.isTagged("WalletEnrolled")),
            ),
          );

          const loser = Option.getOrThrow(
            Option.fromNullishOr(
              outcomes.find(Predicate.isTagged("WalletOnDevice")),
            ),
          );

          assertTagged(winner, "WalletEnrolled");
          expect(loser._tag).toBe("WalletOnDevice");

          const persisted = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(persisted.public.address).toBe(winner.profile.address);
          expect(persisted.public.username).toBe(winner.profile.username);
        }),
    );

    it.effect(
      "obtains PRF on a fresh pinned get when create returns none, recovers after a committed backup whose response is lost across reload, and still requires a distinct reopen proof",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const pending = memoryPendingStorage();

          auth.prfOnCreate = false;

          let dropCommittedResponse = true;

          const flakyPort: WalletPort = {
            ...wallet,
            enroll: (enrollment) =>
              dropCommittedResponse
                ? Effect.all(
                    [wallet.enroll(enrollment), wallet.enroll(enrollment)],
                    { concurrency: "unbounded" },
                  ).pipe(
                    Effect.tap(([firstResult, secondResult]) =>
                      Effect.sync(() => {
                        expect(firstResult._tag).toBe("BackupStored");
                        expect(secondResult._tag).toBe("BackupStored");
                      }),
                    ),
                    Effect.andThen(Effect.fail(new Offline())),
                  )
                : wallet.enroll(enrollment),
          };

          const firstTab = enrollmentFor(flakyPort, auth, pending);

          const started = yield* firstTab.start("maria");

          expect(started).toEqual(
            new EnrollmentPending({
              stage: "prf",
              username: Schema.decodeSync(Username)("maria"),
            }),
          );
          expect(auth.issued).toEqual([]);
          expect((yield* tableRows).backups).toEqual([]);
          expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());

          auth.cancels = true;
          expect((yield* firstTab.advance())._tag).toBe("PasskeyCancelled");
          expect(yield* firstTab.pending()).toEqual(Option.some(started));

          auth.cancels = false;
          expect((yield* firstTab.advance())._tag).toBe("Offline");

          const committedRows = yield* tableRows;

          expect(committedRows.backups).toHaveLength(1);

          const committedAddress = committedRows.backups[0]?.address;
          const savedSubmission = Option.getOrThrow(pending.readSync());

          assertTagged(savedSubmission, "PendingBackupSubmission");

          const mismatchedRetry = yield* wallet.enroll(
            new BackupEnrollment({
              ...savedSubmission.enrollment,
              username: Schema.decodeSync(Username)("pedro"),
            }),
          );

          expect(mismatchedRetry._tag).toBe("ChallengeRefused");

          dropCommittedResponse = false;

          const reloadedTab = enrollmentFor(wallet, auth, pending);

          expect(yield* reloadedTab.pending()).toEqual(
            Option.some(
              new EnrollmentPending({
                stage: "backup",
                username: Schema.decodeSync(Username)("maria"),
              }),
            ),
          );
          expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());

          const backupStep = yield* reloadedTab.advance();

          expect(backupStep).toEqual(
            new EnrollmentPending({
              stage: "reopen",
              username: Schema.decodeSync(Username)("maria"),
            }),
          );
          expect((yield* tableRows).backups).toHaveLength(1);
          expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());

          const completed = yield* reloadedTab.advance();

          assertTagged(completed, "WalletEnrolled");
          expect(completed.profile.address).toBe(committedAddress);
          expect(auth.registered).toHaveLength(1);

          const persisted = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(persisted.public.address).toBe(committedAddress);
          expect(persisted.credential.id).toBe(auth.registered[0]?.id);

          const reopened = yield* reopenLocalEnvelope(
            auth.assertions,
            relyingParty,
            persisted.credential,
            persisted.envelope,
            {
              network,
              address: persisted.public.address,
              purpose: "approval",
            },
          );

          assertTagged(reopened, "PhraseOpened");

          const restoredBackup = yield* restoreBackupPhrase(wallet, auth);

          expect(restoredBackup.phrase).toBe(Redacted.value(reopened.phrase));
        }),
    );

    const refusalCases = [
      [
        "the browser reports no WebAuthn or PRF support",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const auth = new SoftwareAuthenticator(passkeyOrigin);

            auth.webAuthnAvailable = false;

            const enrollment = enrollmentFor(wallet, auth);

            return {
              outcome: yield* enrollment.start("maria"),
              expectedTag: "BackupUnsupported",
              enrollment,
              expectZeroBackups: true,
            };
          }),
      ],
      [
        "the authenticator lacks PRF on both create and pinned get",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const auth = new SoftwareAuthenticator(passkeyOrigin);

            auth.prfOnCreate = false;
            auth.prf = false;

            const enrollment = enrollmentFor(wallet, auth);

            const started = yield* enrollment.start("maria");

            assertTagged(started, "EnrollmentPending");
            expect(started.stage).toBe("prf");

            return {
              outcome: yield* enrollment.advance(),
              expectedTag: "BackupUnsupported",
              enrollment,
              expectZeroBackups: true,
            };
          }),
      ],
      [
        "the registration comes from an unlisted origin",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const auth = new SoftwareAuthenticator("https://example.com");

            const enrollment = enrollmentFor(wallet, auth);

            return {
              outcome: yield* enrollment.start("maria"),
              expectedTag: "RegistrationRefused",
              enrollment,
              expectZeroBackups: true,
            };
          }),
      ],
      [
        "persisting the pending submission fails before backup upload",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const auth = new SoftwareAuthenticator(passkeyOrigin);

            const failingPending: PendingEnrollmentStorage = {
              read: () => Effect.succeed(Option.none()),
              write: () =>
                Effect.fail(
                  new KeyStoreUnavailable({ cause: new Error("quota") }),
                ),
              clear: () => Effect.void,
            };

            const enrollment = enrollmentFor(wallet, auth, failingPending);

            return {
              outcome: yield* enrollment.start("maria"),
              expectedTag: "UnsupportedDevice",
              enrollment,
              expectZeroBackups: true,
            };
          }),
      ],
      [
        "the sealed candidate envelope is tampered before reopen proof",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const auth = new SoftwareAuthenticator(passkeyOrigin);
            const pending = memoryPendingStorage();

            const first = enrollmentFor(wallet, auth, pending);

            const started = yield* first.start("maria");

            assertTagged(started, "EnrollmentPending");

            const saved = Option.getOrThrow(pending.readSync());

            assertTagged(saved, "PendingReopenProof");

            const { candidate } = saved;

            const tamperedCiphertext = Uint8Array.from(
              candidate.envelope.ciphertext,
            );

            tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0xff;
            pending.replaceSync(
              new PendingReopenProof({
                candidate: {
                  ...candidate,
                  envelope: new LocalPhraseEnvelope({
                    ...candidate.envelope,
                    ciphertext: tamperedCiphertext,
                  }),
                },
              }),
            );

            const second = enrollmentFor(wallet, auth, pending);

            return {
              outcome: yield* second.advance(),
              expectedTag: "CorruptEnvelope",
              enrollment: second,
              expectZeroBackups: false,
            };
          }),
      ],
    ] as const;

    it.effect.each(refusalCases)(
      "refuses activation without storing a local wallet when %s",
      ([, runCase]) =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = yield* Wallet;

          const { outcome, expectedTag, enrollment, expectZeroBackups } =
            yield* runCase(wallet);

          expect(outcome._tag).toBe(expectedTag);
          expect(yield* enrollment.pending()).toEqual(Option.none());
          expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());

          const rows = yield* tableRows;

          expect(rows.usernames).toEqual([]);
          expect(rows.wallets).toEqual([]);
          expect(rows.backups).toHaveLength(expectZeroBackups ? 0 : 1);
        }),
    );
  },
);
