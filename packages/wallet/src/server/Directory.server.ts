import { Database } from "@workspace/db";
import { type SQL, and, eq, isNull, or, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  DepositOpeningSpent,
  DepositOpeningsFull,
  HumanCheckRefused,
  OpeningDraft,
  Profile,
  SigningRequest,
  Username,
  WalletClaim,
} from "../contract";
import type { RecoveryFacts } from "../stellar/envelopes";
import { epochAt, network } from "../stellar/network";
import type { Sealed } from "./Chain.server";
import { pruneAbandonedOpenings } from "./abandoned-openings.server";
import {
  type DepositOpeningRefusal,
  depositOpeningRefusal,
  depositOpeningsLock,
} from "./deposit-openings.server";
import { markRecoverable, markRecovered } from "./recoverable-wallets.server";
import { pairedRecovery } from "./opening-attempt.server";
import { walletHasSignedWork } from "./signed-work.server";
import { SignedWorkInFlight, walletLock } from "./slot.server";
import { usernames, wallets } from "./tables.server";
import {
  bind,
  boundNames,
  nameOrAddress,
  prepareBind,
} from "./username-binding.server";
import type { Transaction } from "./transaction.server";
import {
  type Binding,
  type BindingUnproven,
  EnrollmentRefused,
  type Unavailable,
  availability,
  profileOf,
  unavailability,
  Available,
} from "./username-standing.server";

export class StoreFailure extends Schema.TaggedError<StoreFailure>()(
  "StoreFailure",
  {
    cause: Schema.Defect(),
  },
) {}

export type WalletRow = typeof wallets.$inferSelect;

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

    bound(claim: WalletClaim): Effect.Effect<boolean, StoreFailure>;

    enrollUnopened(
      claim: WalletClaim,
      alongside: Binding["alongside"],
    ): Effect.Effect<Available | Unavailable, StoreFailure>;

    unopened(
      row: WalletRow,
    ): Effect.Effect<Option.Option<Profile>, StoreFailure>;

    depositOpeningRefusal(
      row: WalletRow,
      cap: number,
    ): Effect.Effect<Option.Option<DepositOpeningRefusal>, StoreFailure>;

    start(
      address: AccountAddress,
      initial?: OpeningDraft,
    ): Effect.Effect<WalletRow, StoreFailure>;
    draft(
      row: WalletRow,
      draft: OpeningDraft,
    ): Effect.Effect<WalletRow, StoreFailure>;

    seal(
      row: WalletRow,
      sealed: Sealed,
      claim: WalletClaim,
      recovery: Option.Option<Sealed>,
      repairing: boolean,
      binding: Binding,
      depositCap: Option.Option<number>,
    ): Effect.Effect<
      WalletRow | Unavailable | SignedWorkInFlight | DepositOpeningRefusal,
      StoreFailure
    >;
    recoveryDraft(
      row: WalletRow,
      request: SigningRequest,
    ): Effect.Effect<WalletRow, StoreFailure>;
    activate(
      row: WalletRow,
      sealed: Sealed,
      facts: RecoveryFacts,
      claim: WalletClaim,
      binding: Binding,
    ): Effect.Effect<Option.Option<Profile> | Unavailable, StoreFailure>;
    activatePaired(
      row: WalletRow,
      facts: RecoveryFacts,
      claim: WalletClaim,
      binding: Binding,
    ): Effect.Effect<Option.Option<Profile> | Unavailable, StoreFailure>;
    hasSignedWork(
      address: AccountAddress,
    ): Effect.Effect<boolean, StoreFailure>;

    recover(row: WalletRow): Effect.Effect<void, StoreFailure>;
    readonly recoverable: Effect.Effect<ReadonlyArray<WalletRow>, StoreFailure>;
    readonly pruneAbandonedOpenings: Effect.Effect<void, StoreFailure>;
  }
>()("@workspace/wallet/server/Directory") {
  static readonly layer = Layer.effect(
    Directory,
    Effect.gen(function* () {
      const db = yield* Database;
      const scope = eq(wallets.network, network);

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

      const lockRow = (tx: Transaction, matching: SQL | undefined) =>
        tx.select().from(wallets).where(matching).for("update");

      const unopenedRow = and(
        eq(wallets.status, "opening"),
        isNull(wallets.attemptHash),
      );

      const enrollUnopened = Effect.fn("Directory.enrollUnopened")(function* (
        claim: WalletClaim,
        alongside: Binding["alongside"],
      ) {
        const now = yield* Clock.currentTimeMillis;

        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(wallets)
                .values({
                  address: claim.address,
                  status: "opening",
                  network,
                  testnetEpoch: epochAt(now),
                })
                .onConflictDoNothing();

              const bound = yield* bind(tx, claim, "verified", alongside);

              const refused = unavailability(bound);

              if (Option.isSome(refused))
                return yield* new EnrollmentRefused({
                  standing: refused.value,
                });

              return new Available();
            }),
          )
          .pipe(
            Effect.catchTag("EnrollmentRefused", ({ standing }) =>
              Effect.succeed(standing),
            ),
          );
      });

      const unopened = Effect.fn("Directory.unopened")(function* (
        row: WalletRow,
      ) {
        if (row.status !== "opening" || row.attemptHash !== null)
          return Option.none<Profile>();

        const names = yield* boundNames(db, eq(usernames.address, row.address));

        return Option.fromNullishOr(names[0]).pipe(Option.map(profileOf));
      });

      const start = Effect.fn("Directory.start")(function* (
        address: AccountAddress,
        initial?: OpeningDraft,
      ) {
        const now = yield* Clock.currentTimeMillis;

        const inserted = yield* db
          .insert(wallets)
          .values({
            address,
            status: "opening",
            network,
            testnetEpoch: epochAt(now),
            attemptEnvelope: initial ? initial.request.envelope : null,
            attemptExpiresAt: initial
              ? DateTime.toDateUtc(initial.request.expiresAt)
              : null,
            pairedRecoveryDraft: initial?.recovery?.envelope ?? null,
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
        drafted: OpeningDraft,
      ) {
        const written = yield* db
          .update(wallets)
          .set({
            version: row.version + 1,
            attemptEnvelope: drafted.request.envelope,
            attemptHash: null,
            attemptExpiresAt: DateTime.toDateUtc(drafted.request.expiresAt),
            pairedRecoveryDraft: drafted.recovery?.envelope ?? null,
            pairedRecoveryEnvelope: null,
            pairedRecoveryHash: null,
            depositOpening: sql`case when ${wallets.depositOpening} = 'recovered' then 'recovered' end`,
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
        recovery: Option.Option<Sealed>,
        repairing: boolean,
        binding: Binding,
        depositCap: Option.Option<number>,
      ) {
        const unchanged = and(
          scope,
          eq(wallets.address, row.address),
          eq(wallets.version, row.version),
        );

        const prepared = yield* prepareBind(db, claim, binding);

        if (prepared instanceof HumanCheckRefused) return prepared;

        const outcome = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const owner = Schema.decodeSync(AccountAddress)(row.address);

            yield* tx.execute(walletLock(owner));

            const locked = yield* lockRow(tx, unchanged);

            if (!locked[0]) return undefined;

            if (Option.isSome(depositCap)) {
              yield* tx.execute(depositOpeningsLock);

              const refused = yield* depositOpeningRefusal(
                tx,
                locked[0],
                depositCap.value,
              );

              if (Option.isSome(refused)) return refused.value;
            }

            if (
              repairing &&
              Option.isSome(recovery) &&
              (yield* walletHasSignedWork(tx, owner))
            )
              return new SignedWorkInFlight();

            const bound = yield* bind(tx, claim, prepared, binding.alongside);

            const refused = unavailability(bound);

            if (Option.isSome(refused)) return refused.value;

            const written = yield* tx
              .update(wallets)
              .set({
                version: row.version + 1,
                attemptEnvelope: sealed.envelope,
                attemptHash: sealed.hash,
                attemptExpiresAt: DateTime.toDateUtc(sealed.expiresAt),
                pairedRecoveryEnvelope: Option.match(recovery, {
                  onNone: () => null,
                  onSome: (signed) => signed.envelope,
                }),
                pairedRecoveryHash: Option.match(recovery, {
                  onNone: () => null,
                  onSome: (signed) => signed.hash,
                }),
                depositOpening: Option.isSome(depositCap)
                  ? "attempted"
                  : locked[0].depositOpening,
              })
              .where(unchanged)
              .returning();

            return written[0];
          }),
        );

        if (
          Predicate.isTagged(outcome, "UsernameTaken") ||
          Predicate.isTagged(outcome, "AddressBound") ||
          outcome instanceof HumanCheckRefused ||
          Predicate.isTagged(outcome, "SignedWorkInFlight") ||
          outcome instanceof DepositOpeningsFull ||
          outcome instanceof DepositOpeningSpent
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
            pairedRecoveryDraft: null,
            pairedRecoveryEnvelope: null,
            pairedRecoveryHash: null,
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

      const activateWhere = Effect.fn("Directory.activateWhere")(function* (
        activatable: SQL | undefined,
        version: number,
        sealed: Sealed,
        facts: RecoveryFacts,
        claim: WalletClaim,
        binding: Binding,
      ) {
        const prepared = yield* prepareBind(db, claim, binding);

        if (prepared instanceof HumanCheckRefused) return prepared;

        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const locked = yield* lockRow(tx, activatable);

            if (!locked[0]) return Option.none<Profile>();

            const bound = yield* bind(tx, claim, prepared, binding.alongside);

            const refused = unavailability(bound);

            if (Option.isSome(refused)) return refused.value;

            const now = yield* Clock.currentTimeMillis;

            const written = yield* tx
              .update(wallets)
              .set({
                status: "active",
                version: version + 1,
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
                pairedRecoveryDraft: null,
                pairedRecoveryEnvelope: null,
                pairedRecoveryHash: null,
              })
              .where(activatable)
              .returning();

            return written[0] ? Option.some(new Profile(claim)) : Option.none();
          }),
        );
      });

      const unactivated = (row: WalletRow) =>
        and(
          scope,
          eq(wallets.address, row.address),
          or(eq(wallets.status, "opening"), eq(wallets.status, "recovered")),
          eq(wallets.version, row.version),
          isNull(wallets.recoveryEnvelope),
        );

      const activate = (
        row: WalletRow,
        sealed: Sealed,
        facts: RecoveryFacts,
        claim: WalletClaim,
        binding: Binding,
      ) =>
        activateWhere(
          and(
            unactivated(row),
            eq(wallets.recoveryDraft, row.recoveryDraft ?? ""),
          ),
          row.version,
          sealed,
          facts,
          claim,
          binding,
        );

      const activatePaired = (
        row: WalletRow,
        facts: RecoveryFacts,
        claim: WalletClaim,
        binding: Binding,
      ) => {
        const signed = pairedRecovery(row);

        return Option.isNone(signed)
          ? Effect.succeed(Option.none<Profile>())
          : activateWhere(
              and(
                unactivated(row),
                eq(
                  wallets.pairedRecoveryEnvelope,
                  signed.value.sealed.envelope,
                ),
              ),
              row.version,
              signed.value.sealed,
              facts,
              claim,
              binding,
            );
      };

      const byUsername = (username: Username) =>
        db
          .select({ username: usernames.username, address: usernames.address })
          .from(usernames)
          .innerJoin(wallets, eq(wallets.address, usernames.address))
          .where(
            and(
              scope,
              eq(usernames.username, username),
              or(eq(wallets.status, "active"), unopenedRow),
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

      const proven = <A, E>(
        program: Effect.Effect<A, E | BindingUnproven>,
      ): Effect.Effect<A | HumanCheckRefused, E> =>
        Effect.catchTag(program, "BindingUnproven", () =>
          Effect.succeed(new HumanCheckRefused()),
        );

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
        bound: (claim) =>
          wrap(
            boundNames(
              db,
              and(
                eq(usernames.username, claim.username),
                eq(usernames.address, claim.address),
              ),
            ).pipe(Effect.map((found) => found.length > 0)),
          ),
        enrollUnopened: (claim, alongside) =>
          wrap(proven(enrollUnopened(claim, alongside))),
        unopened: (row) => wrap(unopened(row)),
        depositOpeningRefusal: (row, cap) =>
          wrap(depositOpeningRefusal(db, row, cap)),
        start: (address, initial) => wrap(start(address, initial)),
        draft: (row, request) => wrap(draft(row, request)),
        seal: (row, sealed, claim, recovery, repairing, binding, depositCap) =>
          wrap(
            proven(
              seal(
                row,
                sealed,
                claim,
                recovery,
                repairing,
                binding,
                depositCap,
              ),
            ),
          ),
        recoveryDraft: (row, request) => wrap(recoveryDraft(row, request)),
        activate: (row, sealed, facts, claim, binding) =>
          wrap(proven(activate(row, sealed, facts, claim, binding))),
        activatePaired: (row, facts, claim, binding) =>
          wrap(proven(activatePaired(row, facts, claim, binding))),
        hasSignedWork: (address) => wrap(walletHasSignedWork(db, address)),
        recover: (row) =>
          wrap(markRecovered(row).pipe(Effect.provideService(Database, db))),
        pruneAbandonedOpenings: wrap(
          pruneAbandonedOpenings().pipe(Effect.provideService(Database, db)),
        ),
        recoverable: wrap(
          markRecoverable().pipe(Effect.provideService(Database, db)),
        ),
      });
    }),
  );
}
