import { Database } from "@workspace/db";
import {
  type SQL,
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressBound,
  Profile,
  SigningRequest,
  Username,
  UsernameTaken,
  WalletClaim,
} from "../contract";
import { RecoveryFacts } from "../stellar/envelopes";
import { epochAt, network, sweepBatchSize } from "../stellar/network";
import { Sealed } from "./Chain.server";
import { usernames, wallets } from "./tables.server";
import { reserved } from "./usernames.server";

export class StoreFailure extends Schema.TaggedError<StoreFailure>()(
  "StoreFailure",
  {
    cause: Schema.Defect(),
  },
) {}

export type WalletRow = typeof wallets.$inferSelect;

type NameRow = Pick<typeof usernames.$inferSelect, "username" | "address">;

export class Available extends Schema.TaggedClass<Available>()(
  "Available",
  {},
) {}

export type Unavailable = UsernameTaken | AddressBound;

export const unavailability = (
  availability: Available | Unavailable,
): Option.Option<Unavailable> =>
  Match.valueTags(availability, {
    Available: () => Option.none(),
    UsernameTaken: Option.some,
    AddressBound: Option.some,
  });

const profileOf = (name: NameRow) =>
  new Profile({
    address: Schema.decodeSync(AccountAddress)(name.address),
    username: Schema.decodeSync(Username)(name.username),
  });

function availability(
  claim: WalletClaim,
  found: ReadonlyArray<NameRow>,
): Available | Unavailable {
  const own = found.find((name) => name.address === claim.address);

  if (own)
    return own.username === claim.username
      ? new Available()
      : new AddressBound({ profile: profileOf(own) });

  if (found.length > 0 || reserved(claim.username))
    return new UsernameTaken({ username: claim.username });

  return new Available();
}

export function openingAttempt(
  row: WalletRow,
): Option.Option<SigningRequest | Sealed> {
  if (!row.attemptEnvelope || !row.attemptExpiresAt) return Option.none();

  const expiresAt = DateTime.makeUnsafe(row.attemptExpiresAt);

  return Option.some(
    row.attemptHash
      ? new Sealed({
          envelope: row.attemptEnvelope,
          hash: row.attemptHash,
          expiresAt,
        })
      : new SigningRequest({
          envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
            row.attemptEnvelope,
          ),
          expiresAt,
        }),
  );
}

export class Directory extends Context.Service<
  Directory,
  {
    byAddress(
      address: AccountAddress,
    ): Effect.Effect<Option.Option<WalletRow>, StoreFailure>;

    byUsername(
      username: Username,
    ): Effect.Effect<Option.Option<Profile>, StoreFailure>;

    profile(row: WalletRow): Effect.Effect<Profile, StoreFailure>;

    available(
      claim: WalletClaim,
    ): Effect.Effect<Available | Unavailable, StoreFailure>;

    start(
      address: AccountAddress,
      initial?: SigningRequest,
    ): Effect.Effect<WalletRow, StoreFailure>;
    draft(
      row: WalletRow,
      request: SigningRequest,
    ): Effect.Effect<WalletRow, StoreFailure>;

    seal(
      row: WalletRow,
      sealed: Sealed,
      claim: WalletClaim,
    ): Effect.Effect<WalletRow | Unavailable, StoreFailure>;
    recoveryDraft(
      row: WalletRow,
      request: SigningRequest,
    ): Effect.Effect<WalletRow, StoreFailure>;
    activate(
      row: WalletRow,
      sealed: Sealed,
      facts: RecoveryFacts,
      claim: WalletClaim,
    ): Effect.Effect<Option.Option<Profile> | Unavailable, StoreFailure>;

    recover(row: WalletRow): Effect.Effect<void, StoreFailure>;
    readonly recoverable: Effect.Effect<ReadonlyArray<WalletRow>, StoreFailure>;
  }
>()("@workspace/wallet/server/Directory") {
  static readonly layer = Layer.effect(
    Directory,
    Effect.gen(function* () {
      const db = yield* Database;
      const scope = eq(wallets.network, network);

      type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

      const find = (address: AccountAddress) =>
        db
          .select()
          .from(wallets)
          .where(and(scope, eq(wallets.address, address)))
          .pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

      const current = Effect.fn("Directory.current")(function* (
        row: WalletRow,
      ) {
        const found = yield* find(
          Schema.decodeSync(AccountAddress)(row.address),
        );

        if (Option.isNone(found))
          return yield* new StoreFailure({
            cause: new Error("Wallet disappeared"),
          });

        return found.value;
      });

      const nameOrAddress = (claim: WalletClaim) =>
        or(
          eq(usernames.username, claim.username),
          eq(usernames.address, claim.address),
        );

      const boundNames = (
        executor: typeof db | Transaction,
        matching: SQL | undefined,
      ) =>
        executor
          .select({ username: usernames.username, address: usernames.address })
          .from(usernames)
          .where(matching);

      const lockRow = (tx: Transaction, matching: SQL | undefined) =>
        tx.select().from(wallets).where(matching).for("update");

      const bind = Effect.fn("Directory.bind")(function* (
        tx: Transaction,
        claim: WalletClaim,
      ) {
        if (reserved(claim.username)) {
          const own = yield* boundNames(tx, nameOrAddress(claim));

          return own.some((name) => name.address === claim.address)
            ? availability(claim, own)
            : new UsernameTaken({ username: claim.username });
        }

        const inserted = yield* tx
          .insert(usernames)
          .values(claim)
          .onConflictDoNothing()
          .returning();

        if (inserted[0]) return new Available();

        const holders = yield* boundNames(tx, nameOrAddress(claim));

        if (holders.length === 0)
          return yield* new StoreFailure({
            cause: new Error("Binding conflict without a holder"),
          });

        return availability(claim, holders);
      });

      const start = Effect.fn("Directory.start")(function* (
        address: AccountAddress,
        initial?: SigningRequest,
      ) {
        const now = yield* Clock.currentTimeMillis;

        const inserted = yield* db
          .insert(wallets)
          .values({
            address,
            status: "opening",
            network,
            testnetEpoch: epochAt(now),
            attemptEnvelope: initial ? initial.envelope : null,
            attemptExpiresAt: initial
              ? DateTime.toDateUtc(initial.expiresAt)
              : null,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted[0]) return inserted[0];

        const found = yield* find(address);

        if (Option.isNone(found))
          return yield* new StoreFailure({
            cause: new Error("Wallet belongs to another network"),
          });

        return found.value;
      });

      const draft = Effect.fn("Directory.draft")(function* (
        row: WalletRow,
        request: SigningRequest,
      ) {
        const written = yield* db
          .update(wallets)
          .set({
            version: row.version + 1,
            attemptEnvelope: request.envelope,
            attemptHash: null,
            attemptExpiresAt: DateTime.toDateUtc(request.expiresAt),
          })
          .where(
            and(
              scope,
              eq(wallets.address, row.address),
              eq(wallets.version, row.version),
            ),
          )
          .returning();

        return written[0] ?? (yield* current(row));
      });

      const seal = Effect.fn("Directory.seal")(function* (
        row: WalletRow,
        sealed: Sealed,
        claim: WalletClaim,
      ) {
        const unchanged = and(
          scope,
          eq(wallets.address, row.address),
          eq(wallets.version, row.version),
        );

        const outcome = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const locked = yield* lockRow(tx, unchanged);

            if (!locked[0]) return undefined;

            const bound = yield* bind(tx, claim);

            const refused = unavailability(bound);

            if (Option.isSome(refused)) return refused.value;

            const written = yield* tx
              .update(wallets)
              .set({
                version: row.version + 1,
                attemptEnvelope: sealed.envelope,
                attemptHash: sealed.hash,
                attemptExpiresAt: DateTime.toDateUtc(sealed.expiresAt),
              })
              .where(unchanged)
              .returning();

            return written[0];
          }),
        );

        if (
          Predicate.isTagged(outcome, "UsernameTaken") ||
          Predicate.isTagged(outcome, "AddressBound")
        )
          return outcome;

        return outcome ?? (yield* current(row));
      });

      const recoveryDraft = Effect.fn("Directory.recoveryDraft")(function* (
        row: WalletRow,
        request: SigningRequest,
      ) {
        const written = yield* db
          .update(wallets)
          .set({
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

      const activate = (
        row: WalletRow,
        sealed: Sealed,
        facts: RecoveryFacts,
        claim: WalletClaim,
      ) => {
        const activatable = and(
          scope,
          eq(wallets.address, row.address),
          or(eq(wallets.status, "opening"), eq(wallets.status, "recovered")),
          eq(wallets.version, row.version),
          eq(wallets.recoveryDraft, row.recoveryDraft ?? ""),
          isNull(wallets.recoveryEnvelope),
        );

        return db.transaction((tx) =>
          Effect.gen(function* () {
            const locked = yield* lockRow(tx, activatable);

            if (!locked[0]) return Option.none<Profile>();

            const bound = yield* bind(tx, claim);

            const refused = unavailability(bound);

            if (Option.isSome(refused)) return refused.value;

            const now = yield* Clock.currentTimeMillis;

            const written = yield* tx
              .update(wallets)
              .set({
                status: "active",
                version: row.version + 1,
                testnetEpoch: epochAt(now),
                recoveryEnvelope: sealed.envelope,
                recoveryHash: sealed.hash,
                recoverySequence: facts.sequence,
                recoveryMinTime: DateTime.toDateUtc(
                  DateTime.makeUnsafe(facts.minTime * 1000),
                ),
                recoveryMaxTime: DateTime.toDateUtc(
                  DateTime.makeUnsafe(facts.maxTime * 1000),
                ),
              })
              .where(activatable)
              .returning();

            return written[0] ? Option.some(new Profile(claim)) : Option.none();
          }),
        );
      };

      const recover = (row: WalletRow) =>
        db
          .update(wallets)
          .set({
            status: "recovered",
            version: row.version + 1,
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
              eq(wallets.address, row.address),
              eq(wallets.version, row.version),
            ),
          )
          .pipe(Effect.asVoid);

      const byUsername = (username: Username) =>
        db
          .select({ username: usernames.username, address: usernames.address })
          .from(usernames)
          .innerJoin(wallets, eq(wallets.address, usernames.address))
          .where(
            and(
              scope,
              eq(usernames.username, username),
              eq(wallets.status, "active"),
            ),
          )
          .pipe(
            Effect.map((rows) =>
              Option.fromNullishOr(rows[0]).pipe(Option.map(profileOf)),
            ),
          );

      const profile = Effect.fn("Directory.profile")(function* (
        row: WalletRow,
      ) {
        const bound = yield* boundNames(db, eq(usernames.address, row.address));

        if (!bound[0])
          return yield* new StoreFailure({
            cause: new Error("Wallet has no bound username"),
          });

        return profileOf(bound[0]);
      });

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.mapError((cause) => new StoreFailure({ cause })));

      return Directory.of({
        byAddress: (address) => wrap(find(address)),
        byUsername: (username) => wrap(byUsername(username)),
        profile: (row) => wrap(profile(row)),
        available: (claim) =>
          wrap(
            boundNames(db, nameOrAddress(claim)).pipe(
              Effect.map((found) => availability(claim, found)),
            ),
          ),
        start: (address, initial) => wrap(start(address, initial)),
        draft: (row, request) => wrap(draft(row, request)),
        seal: (row, sealed, claim) => wrap(seal(row, sealed, claim)),
        recoveryDraft: (row, request) => wrap(recoveryDraft(row, request)),
        activate: (row, sealed, facts, claim) =>
          wrap(activate(row, sealed, facts, claim)),
        recover: (row) => wrap(recover(row)),
        recoverable: wrap(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const nowDate = DateTime.toDateUtc(now);

            return yield* db
              .update(wallets)
              .set({ sweepCheckedAt: nowDate })
              .where(
                and(
                  scope,
                  eq(wallets.status, "active"),
                  lte(wallets.recoveryMinTime, nowDate),
                  gt(wallets.recoveryMaxTime, nowDate),
                  inArray(
                    wallets.address,
                    db
                      .select({ address: wallets.address })
                      .from(wallets)
                      .where(
                        and(
                          scope,
                          eq(
                            wallets.testnetEpoch,
                            epochAt(DateTime.toEpochMillis(now)),
                          ),
                          eq(wallets.status, "active"),
                          isNotNull(wallets.recoveryEnvelope),
                          lte(wallets.recoveryMinTime, nowDate),
                          gt(wallets.recoveryMaxTime, nowDate),
                        ),
                      )
                      .orderBy(
                        sql`${wallets.sweepCheckedAt} asc nulls first`,
                        wallets.address,
                      )
                      .limit(sweepBatchSize),
                  ),
                ),
              )
              .returning();
          }),
        ),
      });
    }),
  );
}
