import { expect, layer } from "@effect/vitest";
import { Database } from "@workspace/db";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssertionRefused,
  BackupEnrollment,
  BackupFound,
  ChallengeRefused,
  CredentialId,
  NoBackup,
  type PasskeyAssertion,
  PasskeyChallenge,
  SessionBegun,
  Username,
  WalletClaim,
  type WalletPort,
} from "../src/contract";
import { backupSalt, sealPhrase } from "../src/device/phrase-seal";
import { generateSecretPhrase } from "../src/device/secret-phrase";
import { Backups } from "../src/server/Backups.server";
import { Principal } from "../src/server/Principal.server";
import { passkeyChallenges } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { backupRows, restoreAssertion } from "./enrollment-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";
import { randomAddress, randomKey } from "./test-keys";
import {
  approveOpening,
  claimFor,
  dbLayer,
  passkeyOrigin,
  settleSubmitted,
  useDisposableDatabase,
  walletForDb,
  walletTestLayer,
} from "./wallet-harness";

const enrollBackedWallet = (
  port: WalletPort,
  auth: SoftwareAuthenticator,
  username: string,
) =>
  Effect.gen(function* () {
    const key = randomKey();
    const claim = claimFor(key, username);
    const issued = yield* port.enrollmentChallenge(claim);

    assertTagged(issued, "ChallengeIssued");

    const { prf, registration } = Option.getOrThrow(
      auth.enrollWithPrf(issued.challenge, yield* backupSalt),
    );

    const enrollment = new BackupEnrollment({
      address: claim.address,
      username: claim.username,
      registration,
      sealed: yield* sealPhrase(prf, generateSecretPhrase()),
    });

    const draft = yield* port.open(claim, Option.none());

    assertTagged(draft, "OpeningDraft");
    assertTagged(
      yield* port.enroll(
        enrollment,
        Option.getOrThrow(approveOpening(key, draft)),
      ),
      "OpeningPending",
    );
    yield* settleSubmitted();
    assertTagged(yield* port.open(claim, Option.none()), "Opened");
  });

const sessionAssertion = (
  auth: SoftwareAuthenticator,
  credentialId: PasskeyAssertion["id"],
  challenge: PasskeyChallenge,
) =>
  auth.assertions
    .assert({ credentialId, challenge, prf: Option.none() })
    .pipe(Effect.map((platform) => platform.assertion));

const atRequest = <A, E>(program: Effect.Effect<A, E, Wallet | Principal>) =>
  program.pipe(Effect.provide(Layer.fresh(walletForDb(dbLayer))), Effect.orDie);

const beginningSession = (assertion: PasskeyAssertion) =>
  atRequest(
    Effect.gen(function* () {
      const step = yield* (yield* Wallet).beginSession(assertion);

      return { step, issued: yield* (yield* Principal).issued };
    }),
  );

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "restore releases a backup only for a fresh restore challenge and its own credential",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);

          yield* enrollBackedWallet(wallet, auth, "maria");
          const fresh = yield* restoreAssertion(wallet, auth);

          expect(yield* wallet.restore(fresh)).toBeInstanceOf(BackupFound);
          expect(yield* wallet.restore(fresh)).toEqual(new ChallengeRefused());

          const expiring = yield* restoreAssertion(wallet, auth);
          const db = yield* Database;

          yield* db
            .update(passkeyChallenges)
            .set({ expiresAt: new Date(Date.now() - 1000) });
          expect(yield* wallet.restore(expiring)).toEqual(
            new ChallengeRefused(),
          );

          const issued = yield* wallet.enrollmentChallenge(
            new WalletClaim({
              username: Schema.decodeSync(Username)("pedro"),
              address: randomAddress(),
            }),
          );

          assertTagged(issued, "ChallengeIssued");

          const enrollment = issued.challenge;
          const invented = Schema.decodeSync(PasskeyChallenge)("A".repeat(43));

          expect(
            yield* wallet.restore(
              yield* restoreAssertion(wallet, auth, enrollment),
            ),
          ).toEqual(new ChallengeRefused());
          expect(
            yield* wallet.restore(
              yield* restoreAssertion(wallet, auth, invented),
            ),
          ).toEqual(new ChallengeRefused());

          const impostor = new SoftwareAuthenticator(passkeyOrigin);

          impostor.forge(fresh.id);
          expect(
            yield* wallet.restore(yield* restoreAssertion(wallet, impostor)),
          ).toEqual(new AssertionRefused());

          const stranger = new SoftwareAuthenticator(passkeyOrigin);

          stranger.forge("c3RyYW5nZXI");
          expect(
            yield* wallet.restore(yield* restoreAssertion(wallet, stranger)),
          ).toEqual(new NoBackup());
        }),
    );

    it.effect(
      "beginSession grants a session only for a fresh session challenge, the wallet's own credential and a verified user",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const auth = new SoftwareAuthenticator(passkeyOrigin);

          yield* enrollBackedWallet(wallet, auth, "maria");

          const credentialId = Option.getOrThrow(
            Option.fromNullishOr(auth.registered[0]),
          ).id;

          const fresh = () =>
            wallet
              .sessionChallenge()
              .pipe(
                Effect.flatMap((challenge) =>
                  sessionAssertion(auth, credentialId, challenge),
                ),
              );

          const granted = yield* beginningSession(yield* fresh());

          expect(granted.step).toEqual(new SessionBegun());
          expect(Option.isSome(granted.issued)).toBe(true);

          const reused = yield* fresh();

          expect((yield* beginningSession(reused)).step).toEqual(
            new SessionBegun(),
          );

          const replayed = yield* beginningSession(reused);

          expect(replayed.step).toEqual(new ChallengeRefused());
          expect(replayed.issued).toEqual(Option.none());

          const restoring = yield* beginningSession(
            yield* sessionAssertion(
              auth,
              credentialId,
              yield* wallet.restoreChallenge(),
            ),
          );

          expect(restoring.step).toEqual(new ChallengeRefused());
          expect(restoring.issued).toEqual(Option.none());

          auth.userVerified = false;

          const unverified = yield* beginningSession(yield* fresh());

          expect(unverified.step).toEqual(new AssertionRefused());
          expect(unverified.issued).toEqual(Option.none());
          auth.userVerified = true;

          const impostor = new SoftwareAuthenticator(passkeyOrigin);

          impostor.forge(credentialId);

          const forged = yield* beginningSession(
            yield* sessionAssertion(
              impostor,
              credentialId,
              yield* wallet.sessionChallenge(),
            ),
          );

          expect(forged.step).toEqual(new AssertionRefused());
          expect(forged.issued).toEqual(Option.none());

          const stranger = new SoftwareAuthenticator(passkeyOrigin);

          stranger.forge("c3RyYW5nZXI");

          const unknown = yield* beginningSession(
            yield* sessionAssertion(
              stranger,
              Schema.decodeSync(CredentialId)("c3RyYW5nZXI"),
              yield* wallet.sessionChallenge(),
            ),
          );

          expect(unknown.step).toEqual(new NoBackup());
          expect(unknown.issued).toEqual(Option.none());
        }),
    );

    it.effect("a stored signature counter never moves backwards", () =>
      Effect.gen(function* () {
        const wallet = yield* Wallet;
        const auth = new SoftwareAuthenticator(passkeyOrigin);

        yield* enrollBackedWallet(wallet, auth, "maria");

        const stored = Option.getOrThrow(
          Option.fromNullishOr((yield* backupRows)[0]),
        );

        const store = yield* Backups;
        const credential = Schema.decodeSync(CredentialId)(stored.credentialId);

        yield* store.advance(credential, 7);
        yield* store.advance(credential, 3);

        expect(
          Option.getOrThrow(Option.fromNullishOr((yield* backupRows)[0]))
            .counter,
        ).toBe(7);
      }),
    );
  },
);
