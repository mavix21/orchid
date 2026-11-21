import { assertTagged } from "./tagged";
import { AssetOrders } from "../src/server/AssetOrders.server";
import { Backups } from "../src/server/Backups.server";
import { expect, it } from "@effect/vitest";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { Database, databaseLayer } from "@workspace/db";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  AccountAddress,
  Approval,
  Opened,
  OpeningDraft,
  OpeningPending,
  Profile,
  UsernameTaken,
  WalletClaim,
} from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { usernames, wallets } from "../src/server/tables.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import {
  dbLayer,
  fakeChain,
  settings,
  addressOf,
  approve,
  claimFor,
  useDisposableDatabase,
} from "./wallet-harness";

useDisposableDatabase();

it.live("existing wallet rows migrate into permanent name bindings", () =>
  Effect.gen(function* () {
    const folder = `${import.meta.dirname}/../drizzle`;

    const before = yield* Effect.acquireRelease(
      Effect.promise(() =>
        mkdtemp(join(tmpdir(), "orchid-wallet-migrations-")),
      ),
      (folder) =>
        Effect.promise(() => rm(folder, { recursive: true, force: true })),
    );

    const scratchName = `wallet_migration_${crypto.randomUUID().replaceAll("-", "")}`;

    const control = (statement: ReturnType<typeof sql>) =>
      Database.use((db) => db.execute(statement)).pipe(Effect.provide(dbLayer));

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

    for (const name of (yield* Effect.promise(() => readdir(folder)))
      .sort()
      .slice(0, 2))
      yield* Effect.promise(() =>
        cp(join(folder, name), join(before, name), { recursive: true }),
      );

    yield* Effect.acquireRelease(
      control(sql.raw(`create database ${scratchName}`)),
      () =>
        control(
          sql.raw(`drop database if exists ${scratchName} with (force)`),
        ).pipe(Effect.orDie),
    );

    yield* Effect.gen(function* () {
      const db = yield* Database;

      yield* migrate(db, { migrationsFolder: before });

      const row = (
        address: AccountAddress | undefined,
        username: string,
        status: string,
        extra: string,
      ) =>
        db.execute(
          sql.raw(
            `insert into wallets (address, username, status, "ownershipBound", network, "testnetEpoch", "attemptEnvelope", "attemptHash", "attemptExpiresAt", "recoveryDraft", "recoveryEnvelope", "recoveryHash", "recoverySequence", "recoveryMinTime", "recoveryMaxTime") values ('${address}', '${username}', '${status}', ${extra})`,
          ),
        );

      const recovery = `'draft', 'envelope', 'hash', '1001', now(), now() + interval '1 day'`;

      yield* row(
        unsigned,
        "unsigned",
        "claimed",
        `false, 'testnet', 'before-2026-12-16', 'draft', null, now(), null, null, null, null, null, null`,
      );
      yield* row(
        signedClaim,
        "signed",
        "claimed",
        `false, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), null, null, null, null, null, null`,
      );
      yield* row(
        legacyClaim,
        "legacy",
        "claimed",
        `true, 'testnet', 'before-2026-12-16', 'draft', null, now(), null, null, null, null, null, null`,
      );
      yield* row(
        opened,
        "opened",
        "opening",
        `true, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), 'draft', null, null, null, null, now() + interval '1 day'`,
      );
      yield* row(
        reopening,
        "reopening",
        "reopening",
        `true, 'testnet', 'before-2026-12-16', 'draft', null, now(), null, null, null, null, null, null`,
      );
      yield* row(
        active,
        "active",
        "active",
        `true, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), ${recovery}`,
      );
      yield* row(
        recovered,
        "recovered",
        "recovered",
        `true, 'testnet', 'before-2026-12-16', 'sealed', 'hash', now(), ${recovery}`,
      );

      yield* migrate(db, { migrationsFolder: folder });
    }).pipe(Effect.provide(scratchLayer));

    const migrated = yield* Effect.gen(function* () {
      const db = yield* Database;

      const names = yield* db
        .select()
        .from(usernames)
        .orderBy(usernames.username);

      const rows = yield* db.select().from(wallets);

      return { names, rows };
    }).pipe(Effect.provide(scratchLayer));

    expect(migrated.names.map((name) => [name.username, name.address])).toEqual(
      [
        ["active", active],
        ["legacy", legacyClaim],
        ["opened", opened],
        ["recovered", recovered],
        ["reopening", reopening],
        ["signed", signedClaim],
      ],
    );
    const status = new Map(migrated.rows.map((row) => [row.address, row]));
    expect(status.get(unsigned)?.status).toBe("opening");
    expect(status.get(signedClaim)?.status).toBe("opening");
    expect(status.get(legacyClaim)?.status).toBe("opening");
    expect(status.get(opened)?.status).toBe("opening");
    expect(status.get(reopening)?.status).toBe("recovered");
    expect(status.get(reopening)?.attemptEnvelope).toBe("draft");
    expect(status.get(active)?.status).toBe("active");
    expect(status.get(recovered)?.status).toBe("recovered");
    expect(status.get(recovered)?.recoveryEnvelope).toBeNull();
    expect(status.get(recovered)?.attemptHash).toBeNull();

    const scratchWallet = Wallet.serviceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Directory.layer,
          Transfers.layer,
          AssetOrders.layer,
          Backups.layer,
        ).pipe(Layer.provide(scratchLayer)),
      ),
      Layer.provide(fakeChain),
      Layer.provide(settings),
    );

    const reopen = (
      claim: WalletClaim,
      approval: Option.Option<Approval> = Option.none(),
    ) =>
      Wallet.use((wallet) => wallet.open(claim, approval)).pipe(
        Effect.provide(scratchWallet),
      );

    const recoveredKey = keys[6] ?? Keypair.random();
    const claim = claimFor(recoveredKey, "recovered");
    expect(
      yield* reopen(claimFor(Keypair.random(), "unsigned")),
    ).toBeInstanceOf(OpeningDraft);
    expect(yield* reopen(claimFor(Keypair.random(), "signed"))).toBeInstanceOf(
      UsernameTaken,
    );
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
