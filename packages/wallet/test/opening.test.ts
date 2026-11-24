import { expect, layer } from "@effect/vitest";
import {
  Account,
  Keypair,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressBound,
  AddressRecipient,
  Opened,
  Profile,
  Username,
  WalletClaim,
} from "../src/contract";
import { Database } from "@workspace/db";
import { sql } from "drizzle-orm";
import { Sealed } from "../src/server/Chain.server";
import { SignedWorkInFlight } from "../src/server/slot.server";
import { Directory } from "../src/server/Directory.server";
import { draftOpening, readEnvelope } from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  amount,
  approve,
  approveOpening,
  authorizeTransfer,
  claimFor,
  create,
  feePayer,
  findWallet,
  fundedWallet,
  bindingAllowed,
  opening,
  orderFor,
  overviewOf,
  selfOrder,
  reserveSponsor,
  send,
  settleAttempt,
  sponsor,
  useDisposableDatabase,
  walletTestLayer,
  walletWithChain,
  world,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "opening resumes missing recovery and never activates without a valid signature",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");
          const draft = yield* opening(claim);

          assertTagged(draft, "OpeningDraft");
          expect(draft.recovery).toBeDefined();

          const unrecoverable = Option.some([
            Option.getOrThrow(approve(draft.request, key)),
            Option.getOrThrow(
              approve(
                Option.getOrThrow(Option.fromNullishOr(draft.recovery)),
                Keypair.random(),
              ),
            ),
          ] as const);

          expect(yield* opening(claim, unrecoverable)).toEqual(draft);
          expect(world.submitted).toHaveLength(0);
          expect((yield* opening(claim, approveOpening(key, draft)))._tag).toBe(
            "OpeningPending",
          );

          expect((yield* opening(claim))._tag).toBe("OpeningPending");
          yield* Database.use((db) =>
            db.execute(
              sql`update wallets set "attemptExpiresAt" = now() - interval '1 minute' where address = ${claim.address}`,
            ),
          );

          const recovery = yield* opening(claim);

          assertTagged(recovery, "RecoveryDraft");
          expect(yield* opening(claim)).toEqual(recovery);
          expect(
            (yield* findWallet(claim.address)).pipe(
              Option.map((r) => r.status),
            ),
          ).toEqual(Option.some("opening"));
          expect(
            yield* opening(claim, approveOpening(Keypair.random(), recovery)),
          ).toEqual(recovery);
          expect(
            (yield* opening(claim, approveOpening(key, recovery)))._tag,
          ).toBe("Opened");
          expect(world.submitted).toHaveLength(1);

          const pairedKey = Keypair.random();
          const paired = claimFor(pairedKey, "pedro");
          const pairedDraft = yield* opening(paired);

          assertTagged(pairedDraft, "OpeningDraft");
          yield* opening(paired, approveOpening(pairedKey, pairedDraft));
          yield* settleAttempt(paired.address, 120);

          const visible = Option.getOrThrow(
            Option.fromNullishOr(world.accounts.get(paired.address)),
          );

          world.accounts.delete(paired.address);
          expect((yield* opening(paired))._tag).toBe("OpeningPending");
          expect(
            Option.getOrThrow(yield* findWallet(paired.address))
              .pairedRecoveryEnvelope,
          ).not.toBeNull();
          world.accounts.set(paired.address, visible);
          expect((yield* opening(paired))._tag).toBe("Opened");

          const row = Option.getOrThrow(yield* findWallet(paired.address));

          expect(row.status).toBe("active");
          expect(row.recoverySequence).toBe(
            Option.getOrThrow(
              readEnvelope(
                Option.getOrThrow(Option.fromNullishOr(pairedDraft.recovery))
                  .envelope,
              ),
            ).sequence,
          );

          const advancedKey = Keypair.random();
          const advanced = claimFor(advancedKey, "lucia");
          const advancedDraft = yield* opening(advanced);

          assertTagged(advancedDraft, "OpeningDraft");
          yield* opening(advanced, approveOpening(advancedKey, advancedDraft));
          yield* settleAttempt(advanced.address);
          world.accounts.set(
            advanced.address,
            accountState({
              sequence: "5000",
              balance: Option.some(amount("0")),
            }),
          );
          assertTagged(yield* opening(advanced), "RecoveryDraft");
          expect(
            Option.getOrThrow(yield* findWallet(advanced.address)).status,
          ).toBe("opening");
        }),
    );

    it.effect(
      "a repair is drafted unbumped and unpaired while a signed transfer is in flight",
      () =>
        Effect.gen(function* () {
          const key = yield* fundedWallet();
          const claim = claimFor(key, "maria");

          const funded = Option.getOrThrow(
            Option.fromNullishOr(world.accounts.get(claim.address)),
          );

          yield* authorizeTransfer(key, selfOrder(key), { failSubmit: true });
          world.accounts.set(
            claim.address,
            accountState({
              sequence: funded.sequence,
              balance: Option.none(),
            }),
          );
          expect((yield* opening(claim))._tag).toBe("OpeningPending");

          const repair = yield* opening(claim);

          assertTagged(repair, "OpeningDraft");
          expect(repair.recovery).toBeUndefined();
          expect(
            Option.getOrThrow(readEnvelope(repair.request.envelope)),
          ).toMatchObject({ createAccount: false, window: undefined });

          const placeholder = new Sealed({
            envelope: "AAAA",
            hash: "00".repeat(32),
            expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
          });

          const stored = Option.getOrThrow(yield* findWallet(claim.address));

          expect(
            yield* Directory.use((directory) =>
              directory.seal(
                stored,
                placeholder,
                claim,
                Option.some(placeholder),
                true,
                bindingAllowed,
              ),
            ),
          ).toEqual(new SignedWorkInFlight());
        }),
    );

    it.effect("missing trustline reopens with the same username and key", () =>
      Effect.gen(function* () {
        const key = Keypair.random();
        const claim = yield* create(key, "maria");

        world.accounts.set(
          claim.address,
          accountState({ sequence: "2000", balance: Option.none() }),
        );
        expect((yield* overviewOf(claim.address))._tag).toBe("NeedsReopening");
        expect(
          (yield* findWallet(claim.address)).pipe(Option.map((r) => r.status)),
        ).toEqual(Option.some("recovered"));
        yield* create(key, "maria");
        expect((yield* overviewOf(claim.address))._tag).toBe("Holding");
      }),
    );

    it.effect(
      "a sealed opening outside RPC history redrafts after the ledger passes maxTime",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");
          const row = yield* Directory.use((d) => d.start(claim.address));
          const now = Math.floor(Date.now() / 1000);

          const inner = TransactionBuilder.fromXDR(
            draftOpening({
              source: new Account(reserveSponsor, "100"),
              address: claim.address,
              createAccount: true,
              minTime: now - 200,
              maxTime: now - 80,
            }),
            networkPassphrase,
          );

          if (!(inner instanceof Transaction))
            throw new Error("Expected inner transaction");

          inner.sign(sponsor, key);

          const outer = TransactionBuilder.buildFeeBumpTransaction(
            feePayer.publicKey(),
            "100",
            inner,
            networkPassphrase,
          );

          outer.sign(feePayer);

          const historical = new Sealed({
            envelope: outer.toXDR(),
            hash: Buffer.from(outer.hash()).toString("hex"),
            expiresAt: DateTime.makeUnsafe((now - 80) * 1000),
          });

          yield* Directory.use((d) =>
            d.seal(
              row,
              historical,
              claim,
              Option.none(),
              false,
              bindingAllowed,
            ),
          );
          expect((yield* opening(claim))._tag).toBe("OpeningDraft");
          expect(world.submitted).toHaveLength(0);
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).attemptHash,
          ).toBeNull();
        }),
    );

    it.effect(
      "one missing RPC observation does not demote an active wallet",
      () =>
        Effect.gen(function* () {
          const claim = yield* create(Keypair.random(), "maria");
          let reads = 0;

          const transientWallet = walletWithChain((actual) => ({
            account: (addr) =>
              ++reads === 1
                ? Effect.succeed(Option.none())
                : actual.account(addr),
          }));

          expect(
            (yield* overviewOf(claim.address).pipe(
              Effect.provide(transientWallet),
            ))._tag,
          ).toBe("Holding");
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).status,
          ).toBe("active");
        }),
    );

    it.effect(
      "a partially sponsored account never receives a recovery draft",
      () =>
        Effect.gen(function* () {
          const claim = claimFor(Keypair.random(), "maria");

          world.accounts.set(
            claim.address,
            accountState({
              balance: Option.some(amount("0")),
              accountSponsored: true,
              sponsored: false,
            }),
          );
          expect((yield* opening(claim))._tag).toBe("NotSponsored");
          expect(Option.isNone(yield* findWallet(claim.address))).toBe(true);
          expect(world.submitted).toHaveLength(0);
        }),
    );

    it.effect(
      "bad address checksums are typed refusals before username claims or drafts",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const valid = addressOf(key);

          const bad = Schema.decodeSync(AccountAddress)(
            `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`,
          );

          const claim = new WalletClaim({
            username: Schema.decodeSync(Username)("maria"),
            address: bad,
          });

          expect((yield* opening(claim))._tag).toBe("InvalidAddress");
          expect(Option.isNone(yield* findWallet(bad))).toBe(true);
          expect(
            (yield* send(orderFor(key, AddressRecipient.make({ value: bad }))))
              ._tag,
          ).toBe("InvalidAddress");
          expect(world.submitted).toHaveLength(0);
        }),
    );

    it.effect(
      "existing unnamed account binds once and returns AddressBound to a concurrent caller",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claimA = claimFor(key, "alice");
          const claimB = claimFor(key, "bob");

          world.accounts.set(
            claimA.address,
            accountState({ balance: Option.some(amount("0")) }),
          );

          const draftStarted = yield* Latch.make();
          const resumeDraft = yield* Latch.make();

          const pausedWallet = walletWithChain((actual) => ({
            draftRecovery: (addr) =>
              draftStarted.open.pipe(
                Effect.andThen(resumeDraft.await),
                Effect.andThen(actual.draftRecovery(addr)),
              ),
          }));

          const callerA = yield* opening(claimA).pipe(
            Effect.provide(pausedWallet),
            Effect.forkChild,
          );

          yield* draftStarted.await;
          const bDraft = yield* opening(claimB);

          assertTagged(bDraft, "RecoveryDraft");
          expect(yield* opening(claimB, approveOpening(key, bDraft))).toEqual(
            new Opened({ profile: new Profile(claimB) }),
          );
          expect(world.submitted).toHaveLength(0);
          expect((yield* opening(claimFor(Keypair.random(), "bob")))._tag).toBe(
            "UsernameTaken",
          );

          yield* resumeDraft.open;
          expect(yield* Fiber.join(callerA)).toEqual(
            new AddressBound({
              profile: new Profile({
                address: claimA.address,
                username: claimB.username,
              }),
            }),
          );
        }),
    );
  },
);
