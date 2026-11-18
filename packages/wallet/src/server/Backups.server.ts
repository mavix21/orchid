import { makeDatabase } from "@workspace/db";
import { and, eq, lte } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ChallengePurpose, PasskeyChallenge } from "../contract";
import { StoreFailure } from "./Directory.server";
import { backups, passkeyChallenges, usernames } from "./tables.server";

const challengeLifetimeMillis = 5 * 60_000;

export type BackupRow = typeof backups.$inferSelect;

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
      credentialId: string,
    ): Effect.Effect<
      Option.Option<{ backup: BackupRow; boundUsername: string | null }>,
      StoreFailure
    >;

    advance(
      credentialId: string,
      counter: number,
    ): Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/Backups") {
  static readonly layer = Layer.effect(
    Backups,
    Effect.gen(function* () {
      const db = yield* makeDatabase();

      const issue = Effect.fn("Backups.issue")(function* (
        purpose: ChallengePurpose,
      ) {
        const challenge = Schema.decodeSync(PasskeyChallenge)(
          Schema.encodeSync(Schema.Uint8ArrayFromBase64Url)(
            crypto.getRandomValues(new Uint8Array(32)),
          ),
        );

        yield* db
          .delete(passkeyChallenges)
          .where(lte(passkeyChallenges.expiresAt, new Date()));

        yield* db.insert(passkeyChallenges).values({
          challenge,
          purpose,
          expiresAt: new Date(Date.now() + challengeLifetimeMillis),
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

        return removed.some((row) => row.expiresAt.getTime() > Date.now());
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
        credentialId: string,
      ) {
        const found = yield* db
          .select({ backup: backups, boundUsername: usernames.username })
          .from(backups)
          .leftJoin(usernames, eq(usernames.address, backups.address))
          .where(eq(backups.credentialId, credentialId));

        return Option.fromNullishOr(found[0]);
      });

      const advance = (credentialId: string, counter: number) =>
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
