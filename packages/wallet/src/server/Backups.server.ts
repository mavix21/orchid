import { Database } from "@workspace/db";
import { and, eq, lte } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type ChallengePurpose,
  CredentialId,
  PasskeyChallenge,
  Profile,
  SealedPhrase,
  Username,
} from "../contract";
import { StoreFailure } from "./Directory.server";
import { backups, passkeyChallenges, usernames } from "./tables.server";

const challengeLifetime = { minutes: 5 };

type BackupRow = typeof backups.$inferSelect;

export interface StoredBackup {
  readonly credentialId: CredentialId;
  readonly profile: Profile;
  readonly publicKey: string;
  readonly algorithm: BackupRow["algorithm"];
  readonly counter: number;
  readonly sealed: SealedPhrase;
}

const storedBackup = (
  backup: BackupRow,
  boundUsername: string | null,
): StoredBackup => ({
  credentialId: Schema.decodeSync(CredentialId)(backup.credentialId),
  profile: new Profile({
    address: Schema.decodeSync(AccountAddress)(backup.address),
    username: Schema.decodeSync(Username)(boundUsername ?? backup.username),
  }),
  publicKey: backup.publicKey,
  algorithm: backup.algorithm,
  counter: backup.counter,
  sealed: Schema.decodeSync(SealedPhrase)({
    iv: backup.iv,
    ciphertext: backup.ciphertext,
  }),
});

export type NewBackup = Omit<typeof backups.$inferInsert, "enrolledAt">;

export class Backups extends Context.Service<
  Backups,
  {
    issue(
      purpose: ChallengePurpose,
    ): Effect.Effect<PasskeyChallenge, StoreFailure>;

    consume(
      challenge: PasskeyChallenge,
      purpose: ChallengePurpose,
    ): Effect.Effect<boolean, StoreFailure>;

    enroll(backup: NewBackup): Effect.Effect<boolean, StoreFailure>;

    byCredential(
      credentialId: CredentialId,
    ): Effect.Effect<Option.Option<StoredBackup>, StoreFailure>;

    advance(
      credentialId: CredentialId,
      counter: number,
    ): Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/Backups") {
  static readonly layer = Layer.effect(
    Backups,
    Effect.gen(function* () {
      const db = yield* Database;

      const issue = Effect.fn("Backups.issue")(function* (
        purpose: ChallengePurpose,
      ) {
        const challenge = Schema.decodeSync(PasskeyChallenge)(
          Schema.encodeSync(Schema.Uint8ArrayFromBase64Url)(
            crypto.getRandomValues(new Uint8Array(32)),
          ),
        );

        const cleanupAt = yield* DateTime.now;

        yield* db
          .delete(passkeyChallenges)
          .where(
            lte(passkeyChallenges.expiresAt, DateTime.toDateUtc(cleanupAt)),
          );

        const issuedAt = yield* DateTime.now;

        yield* db.insert(passkeyChallenges).values({
          challenge,
          purpose,
          expiresAt: DateTime.toDateUtc(
            DateTime.add(issuedAt, challengeLifetime),
          ),
        });

        return challenge;
      });

      const consume = Effect.fn("Backups.consume")(function* (
        challenge: PasskeyChallenge,
        purpose: ChallengePurpose,
      ) {
        const removed = yield* db
          .delete(passkeyChallenges)
          .where(
            and(
              eq(passkeyChallenges.challenge, challenge),
              eq(passkeyChallenges.purpose, purpose),
            ),
          )
          .returning();

        const now = yield* Clock.currentTimeMillis;

        return removed.some((row) => row.expiresAt.getTime() > now);
      });

      const enroll = Effect.fn("Backups.enroll")(function* (backup: NewBackup) {
        const inserted = yield* db
          .insert(backups)
          .values(backup)
          .onConflictDoNothing()
          .returning();

        return inserted.length > 0;
      });

      const byCredential = Effect.fn("Backups.byCredential")(function* (
        credentialId: CredentialId,
      ) {
        const found = yield* db
          .select({ backup: backups, boundUsername: usernames.username })
          .from(backups)
          .leftJoin(usernames, eq(usernames.address, backups.address))
          .where(eq(backups.credentialId, credentialId));

        return Option.fromNullishOr(found[0]).pipe(
          Option.map((row) => storedBackup(row.backup, row.boundUsername)),
        );
      });

      const advance = (credentialId: CredentialId, counter: number) =>
        db
          .update(backups)
          .set({ counter })
          .where(eq(backups.credentialId, credentialId))
          .pipe(Effect.asVoid);

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.mapError((cause) => new StoreFailure({ cause })));

      return Backups.of({
        issue: (purpose) => wrap(issue(purpose)),
        consume: (challenge, purpose) => wrap(consume(challenge, purpose)),
        enroll: (backup) => wrap(enroll(backup)),
        byCredential: (credentialId) => wrap(byCredential(credentialId)),
        advance: (credentialId, counter) =>
          wrap(advance(credentialId, counter)),
      });
    }),
  );
}
