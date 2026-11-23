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
import type { RelyingParty } from "../src/device/assertion";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  EnrollmentPending,
  type PendingEnrollmentRecord,
  type PendingEnrollmentStorage,
  PendingActivation,
  PendingCandidate,
  makeEnrollmentEffects,
} from "../src/device/enrollment";
import {
  LocalPhraseEnvelope,
  reopenLocalEnvelope,
} from "../src/device/local-envelope";
import { backupSalt, openPhrase } from "../src/device/phrase-seal";
import { signingKey } from "../src/device/signing";
import { backups, usernames, wallets } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { network } from "../src/stellar/network";
import { clearDatabase, relyingParty } from "./sealed-wallet-fixtures";
import { settlingOpenings } from "./settling-openings";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";
import {
  passkeyOrigin,
  reserveSponsor,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const memoryPendingStorage = (): PendingEnrollmentStorage & {
  tampering: boolean;
  readSync(): Option.Option<PendingEnrollmentRecord>;
} => {
  let saved = Option.none<PendingEnrollmentRecord>();

  const tampered = (record: PendingEnrollmentRecord) => {
    if (!Predicate.isTagged(record, "PendingActivation")) return record;

    const ciphertext = Uint8Array.from(record.candidate.envelope.ciphertext);

    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;

    return new PendingActivation({
      ...record,
      candidate: new PendingCandidate({
        ...record.candidate,
        envelope: new LocalPhraseEnvelope({
          ...record.candidate.envelope,
          ciphertext,
        }),
      }),
    });
  };

  const storage = {
    tampering: false,
    read: () =>
      Effect.sync(() =>
        storage.tampering ? Option.map(saved, tampered) : saved,
      ),
    write: (record: PendingEnrollmentRecord) =>
      Effect.sync(() => {
        saved = Option.some(record);
      }),
    clear: () =>
      Effect.sync(() => {
        saved = Option.none();
      }),
    readSync: () => saved,
  };

  return storage;
};

const enrollmentFor = (
  port: WalletPort,
  auth: SoftwareAuthenticator,
  pending?: PendingEnrollmentStorage,
  party: RelyingParty = relyingParty,
) =>
  makeEnrollmentEffects({
    port,
    store: browserKeyStore,
    registration: auth.registration,
    assertions: auth.assertions,
    relyingParty: party,
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
      "creates a wallet with two passkey prompts: one create and one activation get that seals, signs and releases the opening",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = settlingOpenings(yield* Wallet);
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const tab = enrollmentFor(wallet, auth, memoryPendingStorage());

          const started = yield* tab.start("maria");

          assertTagged(started, "EnrollmentPending");
          expect(started.stage).toBe("activate");
          expect(started.currentUntil).toBeDefined();
          expect(auth.issued).toHaveLength(0);
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());

          const beforeActivation = yield* tableRows;

          expect(beforeActivation.backups).toEqual([]);
          expect(beforeActivation.usernames).toEqual([]);
          expect(world.submitted).toHaveLength(0);

          auth.cancels = true;
          expect((yield* tab.advance())._tag).toBe("PasskeyCancelled");
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());
          expect(world.submitted).toHaveLength(0);
          expect(yield* tab.pending()).toEqual(Option.some(started));

          auth.cancels = false;

          const completed = yield* tab.advance();

          assertTagged(completed, "WalletEnrolled");
          expect(completed.profile.username).toBe("maria");
          expect(auth.registered).toHaveLength(1);
          expect(auth.issued).toHaveLength(1);
          expect(yield* tab.pending()).toEqual(Option.none());
          expect(world.submitted).toHaveLength(1);

          const persisted = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(persisted.public.backup).toBe("stored");
          expect(persisted.public.reserveSponsor).toBe(reserveSponsor);

          const rows = yield* tableRows;

          expect(rows.backups).toHaveLength(1);
          expect(rows.usernames).toHaveLength(1);

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
          expect((yield* tab.start("pedro"))._tag).toBe("WalletOnDevice");
        }),
    );

    it.effect(
      "installs only one wallet when two tabs activate concurrently and releases only the winner",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = settlingOpenings(yield* Wallet);
          const firstAuth = new SoftwareAuthenticator(passkeyOrigin);
          const secondAuth = new SoftwareAuthenticator(passkeyOrigin);

          const firstTab = enrollmentFor(wallet, firstAuth);
          const secondTab = enrollmentFor(wallet, secondAuth);

          assertTagged(yield* firstTab.start("maria"), "EnrollmentPending");
          assertTagged(yield* secondTab.start("pedro"), "EnrollmentPending");

          const outcomes = yield* Effect.all(
            [firstTab.advance(), secondTab.advance()],
            { concurrency: "unbounded" },
          );

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
          expect(world.submitted).toHaveLength(1);
          expect((yield* tableRows).usernames).toHaveLength(1);
        }),
    );

    it.effect(
      "resumes a release whose backup commit was lost across reload without another prompt",
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = settlingOpenings(yield* Wallet);
          const auth = new SoftwareAuthenticator(passkeyOrigin);
          const pending = memoryPendingStorage();

          let dropCommittedResponse = true;

          const flakyPort: WalletPort = {
            ...wallet,
            enroll: (enrollment) =>
              dropCommittedResponse
                ? wallet
                    .enroll(enrollment)
                    .pipe(Effect.andThen(Effect.fail(new Offline())))
                : wallet.enroll(enrollment),
          };

          const firstTab = enrollmentFor(flakyPort, auth, pending);

          assertTagged(yield* firstTab.start("maria"), "EnrollmentPending");
          expect((yield* firstTab.advance())._tag).toBe("Offline");
          expect(auth.issued).toHaveLength(1);

          const committed = yield* tableRows;

          expect(committed.backups).toHaveLength(1);
          expect(world.submitted).toHaveLength(0);
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());

          const savedRelease = Option.getOrThrow(pending.readSync());

          assertTagged(savedRelease, "PendingRelease");

          const mismatchedRetry = yield* wallet.enroll(
            new BackupEnrollment({
              ...savedRelease.enrollment,
              username: Schema.decodeSync(Username)("pedro"),
            }),
          );

          expect(mismatchedRetry._tag).toBe("ChallengeRefused");

          dropCommittedResponse = false;

          const reloadedTab = enrollmentFor(wallet, auth, pending);

          expect(yield* reloadedTab.pending()).toEqual(
            Option.some(
              new EnrollmentPending({
                stage: "release",
                username: Schema.decodeSync(Username)("maria"),
              }),
            ),
          );

          const completed = yield* reloadedTab.advance();

          assertTagged(completed, "WalletEnrolled");
          expect(completed.profile.address).toBe(committed.backups[0]?.address);
          expect(auth.issued).toHaveLength(1);
          expect(world.submitted).toHaveLength(1);
          expect(yield* reloadedTab.pending()).toEqual(Option.none());

          const persisted = Option.getOrThrow(
            yield* browserKeyStore.readSealed(),
          );

          expect(persisted.credential.id).toBe(auth.registered[0]?.id);
        }),
    );

    const refusalCases = [
      [
        "the authenticator returns no PRF on the activation get",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const auth = new SoftwareAuthenticator(passkeyOrigin);

            auth.prf = false;

            const enrollment = enrollmentFor(wallet, auth);

            assertTagged(yield* enrollment.start("maria"), "EnrollmentPending");

            return {
              outcome: yield* enrollment.advance(),
              expectedTag: "BackupUnsupported",
              enrollment,
            };
          }),
      ],
      [
        "the registration comes from an unlisted origin",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const unlisted = {
              origin: "https://example.com",
              rpId: "example.com",
            };

            const auth = new SoftwareAuthenticator(unlisted.origin);

            const enrollment = enrollmentFor(wallet, auth, undefined, unlisted);

            assertTagged(yield* enrollment.start("maria"), "EnrollmentPending");

            return {
              outcome: yield* enrollment.advance(),
              expectedTag: "RegistrationRefused",
              enrollment,
            };
          }),
      ],
      [
        "the persisted candidate envelope is tampered before it is read back",
        (wallet: WalletPort) =>
          Effect.gen(function* () {
            const auth = new SoftwareAuthenticator(passkeyOrigin);
            const pending = memoryPendingStorage();

            const enrollment = enrollmentFor(wallet, auth, pending);

            assertTagged(yield* enrollment.start("maria"), "EnrollmentPending");
            pending.tampering = true;

            return {
              outcome: yield* enrollment.advance(),
              expectedTag: "CorruptEnvelope",
              enrollment,
            };
          }),
      ],
    ] as const;

    it.effect.each(refusalCases)(
      "refuses activation without storing a local wallet, binding a username or releasing a signature when %s",
      ([, runCase]) =>
        Effect.gen(function* () {
          yield* Effect.promise(clearDatabase);

          const wallet = settlingOpenings(yield* Wallet);

          const { outcome, expectedTag, enrollment } = yield* runCase(wallet);

          expect(outcome._tag).toBe(expectedTag);
          expect(yield* enrollment.pending()).toEqual(Option.none());
          expect(yield* browserKeyStore.readPublic()).toEqual(Option.none());
          expect(yield* browserKeyStore.readSealed()).toEqual(Option.none());
          expect((yield* tableRows).usernames).toEqual([]);
          expect(world.submitted).toHaveLength(0);
        }),
    );
  },
);
