import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Database, databaseLayer } from "@workspace/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type Approval,
  Opened,
  OpeningDraft,
  OpeningPending,
  Profile,
  UsernameTaken,
  type WalletClaim,
} from "../src/contract";
import { usernames, wallets } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { assertTagged } from "./tagged";
import {
  addressOf,
  approve,
  claimFor,
  dbLayer,
  walletForDb,
} from "./wallet-harness";

it.live(
  "existing wallet rows migrate into permanent name bindings and replay cleanly",
  () =>
    Effect.gen(function* () {
      const folder = `${import.meta.dirname}/../drizzle`;

      const before = yield* Effect.acquireRelease(
        Effect.promise(() =>
          mkdtemp(join(tmpdir(), "orchid-wallet-migrations-")),
        ),
        (dir) =>
          Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );

      for (const name of (yield* Effect.promise(() => readdir(folder)))
        .sort()
        .slice(0, 2))
        yield* Effect.promise(() =>
          cp(join(folder, name), join(before, name), { recursive: true }),
        );

      const scratchName = `wallet_migration_${crypto.randomUUID().replaceAll("-", "")}`;

      const control = (stmt: ReturnType<typeof sql>) =>
        Database.use((db) => db.execute(stmt)).pipe(Effect.provide(dbLayer));

      yield* Effect.acquireRelease(
        control(sql.raw(`create database ${scratchName}`)),
        () =>
          control(
            sql.raw(`drop database if exists ${scratchName} with (force)`),
          ).pipe(Effect.orDie),
      );

      const scratchLayer = databaseLayer({
        connectionString: `postgres://orchid:orchid-local@127.0.0.1:55433/${scratchName}`,
      });

      const keys = Array.from({ length: 7 }, () => Keypair.random());

      const [
        unsigned,
        signedClaim,
        legacyClaim,
        opened,
        reopening,
        active,
        recovered,
      ] = keys.map(addressOf);

      const recSql = `'draft', 'envelope', 'hash', '1001', now(), now() + interval '1 day'`;
      const noRec = `null, null, null, null, null, null`;

      const history: ReadonlyArray<
        readonly [
          string | undefined,
          string,
          string,
          boolean,
          string,
          string,
          string,
        ]
      > = [
        [unsigned, "unsigned", "claimed", false, "'draft'", "null", noRec],
        [signedClaim, "signed", "claimed", false, "'sealed'", "'hash'", noRec],
        [legacyClaim, "legacy", "claimed", true, "'draft'", "null", noRec],
        [
          opened,
          "opened",
          "opening",
          true,
          "'sealed'",
          "'hash'",
          `'draft', null, null, null, null, now() + interval '1 day'`,
        ],
        [reopening, "reopening", "reopening", true, "'draft'", "null", noRec],
        [active, "active", "active", true, "'sealed'", "'hash'", recSql],
        [
          recovered,
          "recovered",
          "recovered",
          true,
          "'sealed'",
          "'hash'",
          recSql,
        ],
      ];

      const migrated = yield* Effect.gen(function* () {
        const db = yield* Database;

        yield* migrate(db, { migrationsFolder: before });

        for (const [
          address,
          username,
          status,
          bound,
          env,
          hash,
          rec,
        ] of history)
          yield* db.execute(
            sql.raw(
              `insert into wallets (address, username, status, "ownershipBound", network, "testnetEpoch", "attemptEnvelope", "attemptHash", "attemptExpiresAt", "recoveryDraft", "recoveryEnvelope", "recoveryHash", "recoverySequence", "recoveryMinTime", "recoveryMaxTime") values ('${address}', '${username}', '${status}', ${bound}, 'testnet', 'before-2026-12-16', ${env}, ${hash}, now(), ${rec})`,
            ),
          );

        yield* migrate(db, { migrationsFolder: folder });
        yield* migrate(db, { migrationsFolder: folder });

        return {
          names: yield* db.select().from(usernames).orderBy(usernames.username),
          rows: yield* db.select().from(wallets),
        };
      }).pipe(Effect.provide(scratchLayer));

      expect(migrated.names.map((n) => [n.username, n.address])).toEqual([
        ["active", active],
        ["legacy", legacyClaim],
        ["opened", opened],
        ["recovered", recovered],
        ["reopening", reopening],
        ["signed", signedClaim],
      ]);

      const byAddress = new Map(migrated.rows.map((r) => [r.address, r]));

      expect(byAddress.get(unsigned)?.status).toBe("opening");
      expect(byAddress.get(signedClaim)?.status).toBe("opening");
      expect(byAddress.get(legacyClaim)?.status).toBe("opening");
      expect(byAddress.get(opened)?.status).toBe("opening");
      expect(byAddress.get(reopening)?.status).toBe("recovered");
      expect(byAddress.get(reopening)?.attemptEnvelope).toBe("draft");
      expect(byAddress.get(active)?.status).toBe("active");
      expect(byAddress.get(recovered)?.status).toBe("recovered");
      expect(byAddress.get(recovered)?.recoveryEnvelope).toBeNull();
      expect(byAddress.get(recovered)?.attemptHash).toBeNull();

      const scratchWallet = walletForDb(scratchLayer);

      const reopen = (
        claim: WalletClaim,
        approval: Option.Option<Approval> = Option.none(),
      ) =>
        Wallet.use((w) => w.open(claim, approval)).pipe(
          Effect.provide(scratchWallet),
        );

      const recoveredKey = keys[6] ?? Keypair.random();
      const claim = claimFor(recoveredKey, "recovered");

      expect(
        yield* reopen(claimFor(Keypair.random(), "unsigned")),
      ).toBeInstanceOf(OpeningDraft);
      expect(
        yield* reopen(claimFor(Keypair.random(), "signed")),
      ).toBeInstanceOf(UsernameTaken);

      const draft = yield* reopen(claim);

      assertTagged(draft, "OpeningDraft");
      expect(
        yield* reopen(claim, approve(draft.request, recoveredKey)),
      ).toBeInstanceOf(OpeningPending);

      const recoveryStep = yield* reopen(claim);

      assertTagged(recoveryStep, "RecoveryDraft");
      expect(
        yield* reopen(claim, approve(recoveryStep.request, recoveredKey)),
      ).toEqual(new Opened({ profile: new Profile(claim) }));
    }),
);
