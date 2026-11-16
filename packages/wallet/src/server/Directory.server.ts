import { makeDatabase } from "@workspace/db";
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, Profile, SigningRequest, Username, WalletClaim } from "../contract";
import { RecoveryFacts } from "../stellar/envelopes";
import { claimLifetime, epochAt, network, sweepBatchSize } from "../stellar/network";
import { Sealed } from "./Chain.server";
import { wallets } from "./tables.server";

export class StoreFailure extends Schema.TaggedError<StoreFailure>()("StoreFailure", {
  cause: Schema.Defect(),
}) {}

export class Taken extends Schema.TaggedClass<Taken>()("Taken", {}) {}

export type WalletRow = typeof wallets.$inferSelect;

export function profile(row: WalletRow): Profile {
  return new Profile({
    address: Schema.decodeSync(AccountAddress)(row.address),
    username: Schema.decodeSync(Username)(row.username),
  });
}

export function openingAttempt(row: WalletRow): Option.Option<SigningRequest | Sealed> {
  if (!row.attemptEnvelope || !row.attemptExpiresAt) return Option.none();

  const expiresAt = DateTime.makeUnsafe(row.attemptExpiresAt);

  return Option.some(
    row.attemptHash
      ? new Sealed({ envelope: row.attemptEnvelope, hash: row.attemptHash, expiresAt })
      : new SigningRequest({
          envelope: Schema.decodeSync(SigningRequest.fields.envelope)(row.attemptEnvelope),
          expiresAt,
        }),
  );
}

export class Directory extends Context.Service<
  Directory,
  {
    byAddress(address: AccountAddress): Effect.Effect<Option.Option<WalletRow>, StoreFailure>;
    byUsername(username: Username): Effect.Effect<Option.Option<Profile>, StoreFailure>;
    claim(claim: WalletClaim): Effect.Effect<WalletRow | Taken, StoreFailure>;
    attempt(
      row: WalletRow,
      request: SigningRequest | Sealed,
    ): Effect.Effect<WalletRow, StoreFailure>;
    recoveryDraft(row: WalletRow, request: SigningRequest): Effect.Effect<WalletRow, StoreFailure>;
    activate(
      row: WalletRow,
      sealed: Sealed,
      facts: RecoveryFacts,
    ): Effect.Effect<Option.Option<Profile>, StoreFailure>;
    recover(row: WalletRow): Effect.Effect<void, StoreFailure>;
    readonly recoverable: Effect.Effect<ReadonlyArray<WalletRow>, StoreFailure>;
  }
>()("@workspace/wallet/server/Directory") {
  static readonly layer = Layer.effect(
    Directory,
    Effect.gen(function* () {
      const db = yield* makeDatabase();
      const scope = eq(wallets.network, network);

      const find = (address: AccountAddress) =>
        db
          .update(wallets)
          .set({ address })
          .where(and(scope, eq(wallets.address, address)))
          .returning()
          .pipe(
            Effect.map((rows) => Option.fromNullishOr(rows[0])),
            Effect.mapError((cause) => new StoreFailure({ cause })),
          );

      const current = Effect.fn("Directory.current")(function* (row: WalletRow) {
        const found = yield* find(Schema.decodeSync(AccountAddress)(row.address));

        if (Option.isNone(found))
          return yield* new StoreFailure({ cause: new Error("Wallet disappeared") });

        return found.value;
      });

      const claim = Effect.fn("Directory.claim")(function* (claim: WalletClaim) {
        const inserted = yield* db
          .insert(wallets)
          .values({
            ...claim,
            status: "claimed",
            ownershipBound: false,
            network,
            testnetEpoch: epochAt(Date.now()),
          })
          .onConflictDoNothing()
          .returning();

        if (inserted[0]) return inserted[0];

        const takeover = yield* db
          .update(wallets)
          .set({
            address: claim.address,
            version: sql`${wallets.version} + 1`,
            claimedAt: new Date(),
            attemptEnvelope: null,
            attemptExpiresAt: null,
          })
          .where(
            and(
              scope,
              eq(wallets.username, claim.username),
              eq(wallets.status, "claimed"),
              eq(wallets.ownershipBound, false),
              isNull(wallets.attemptHash),
              lt(wallets.claimedAt, new Date(Date.now() - claimLifetime * 1000)),
            ),
          )
          .returning();

        if (takeover[0]) return takeover[0];

        const reopened = yield* db
          .update(wallets)
          .set({
            status: "reopening",
            version: sql`${wallets.version} + 1`,
            testnetEpoch: epochAt(Date.now()),
            claimedAt: new Date(),
            attemptEnvelope: null,
            attemptHash: null,
            attemptExpiresAt: null,
            recoveryDraft: null,
            recoveryEnvelope: null,
            recoveryHash: null,
            recoverySequence: null,
            recoveryMinTime: null,
            recoveryMaxTime: null,
          })
          .where(
            and(
              scope,
              eq(wallets.address, claim.address),
              eq(wallets.username, claim.username),
              eq(wallets.status, "recovered"),
            ),
          )
          .returning();

        if (reopened[0]) return reopened[0];

        const existing = yield* db
          .update(wallets)
          .set({
            username: claim.username,
            claimedAt: sql`case when ${wallets.status} = 'claimed' and not ${wallets.ownershipBound} and ${wallets.attemptHash} is null then now() else ${wallets.claimedAt} end`,
          })
          .where(
            and(scope, eq(wallets.address, claim.address), eq(wallets.username, claim.username)),
          )
          .returning();

        return existing[0] ?? new Taken();
      });

      const attempt = Effect.fn("Directory.attempt")(function* (
        row: WalletRow,
        request: SigningRequest | Sealed,
      ) {
        const written = yield* db
          .update(wallets)
          .set({
            status: row.ownershipBound ? "reopening" : "claimed",
            claimedAt: new Date(),
            version: row.version + 1,
            attemptEnvelope: request.envelope,
            attemptHash: request instanceof Sealed ? request.hash : null,
            attemptExpiresAt: DateTime.toDateUtc(request.expiresAt),
          })
          .where(and(scope, eq(wallets.address, row.address), eq(wallets.version, row.version)))
          .returning();

        return written[0] ?? (yield* current(row));
      });

      const draft = Effect.fn("Directory.recoveryDraft")(function* (
        row: WalletRow,
        request: SigningRequest,
      ) {
        const written = yield* db
          .update(wallets)
          .set({
            status: row.ownershipBound ? "reopening" : "opening",
            version: row.version + 1,
            recoveryDraft: request.envelope,
            recoveryMaxTime: DateTime.toDateUtc(request.expiresAt),
          })
          .where(
            and(
              scope,
              eq(wallets.address, row.address),
              eq(wallets.version, row.version),
              isNull(wallets.recoveryEnvelope),
            ),
          )
          .returning();

        return written[0] ?? (yield* current(row));
      });

      const activate = (row: WalletRow, sealed: Sealed, facts: RecoveryFacts) =>
        db
          .update(wallets)
          .set({
            status: "active",
            ownershipBound: true,
            version: row.version + 1,
            recoveryEnvelope: sealed.envelope,
            recoveryHash: sealed.hash,
            recoverySequence: facts.sequence,
            recoveryMinTime: new Date(facts.minTime * 1000),
            recoveryMaxTime: new Date(facts.maxTime * 1000),
          })
          .where(
            and(
              scope,
              eq(wallets.address, row.address),
              or(eq(wallets.status, "opening"), eq(wallets.status, "reopening")),
              eq(wallets.version, row.version),
              eq(wallets.recoveryDraft, row.recoveryDraft ?? ""),
              isNull(wallets.recoveryEnvelope),
            ),
          )
          .returning()
          .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(profile))));

      const recover = (row: WalletRow) =>
        db
          .update(wallets)
          .set({ status: "recovered", version: row.version + 1 })
          .where(and(scope, eq(wallets.address, row.address), eq(wallets.version, row.version)))
          .pipe(Effect.asVoid);

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.mapError((cause) => new StoreFailure({ cause })));

      return Directory.of({
        byAddress: find,
        byUsername: (username) =>
          wrap(
            db
              .update(wallets)
              .set({ username })
              .where(and(scope, eq(wallets.username, username), eq(wallets.status, "active")))
              .returning()
              .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(profile)))),
          ),
        claim: (input) => wrap(claim(input)),
        attempt: (row, request) => wrap(attempt(row, request)),
        recoveryDraft: (row, request) => wrap(draft(row, request)),
        activate: (row, sealed, facts) => wrap(activate(row, sealed, facts)),
        recover: (row) => wrap(recover(row)),
        recoverable: wrap(
          db
            .update(wallets)
            .set({ sweepCheckedAt: new Date() })
            .where(
              and(
                scope,
                eq(wallets.status, "active"),
                lte(wallets.recoveryMinTime, new Date()),
                gt(wallets.recoveryMaxTime, new Date()),
                inArray(
                  wallets.address,
                  db
                    .select({ address: wallets.address })
                    .from(wallets)
                    .where(
                      and(
                        scope,
                        eq(wallets.testnetEpoch, epochAt(Date.now())),
                        eq(wallets.status, "active"),
                        isNotNull(wallets.recoveryEnvelope),
                        lte(wallets.recoveryMinTime, new Date()),
                        gt(wallets.recoveryMaxTime, new Date()),
                      ),
                    )
                    .orderBy(sql`${wallets.sweepCheckedAt} asc nulls first`, wallets.address)
                    .limit(sweepBatchSize),
                ),
              ),
            )
            .returning(),
        ),
      });
    }),
  );
}
