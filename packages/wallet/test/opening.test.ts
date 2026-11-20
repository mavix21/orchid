import { assertTagged } from "./tagged";
import { expect, layer } from "@effect/vitest";
import {
  Account,
  Transaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressRecipient,
  InvalidAddress,
  NotSponsored,
  Holding,
  NeedsReopening,
  Opened,
  OpeningDraft,
  RecoveryDraft,
  Amount,
  Username,
  UsernameTaken,
  WalletClaim,
} from "../src/contract";
import { Chain, Sealed } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { Wallet } from "../src/server/Wallet.server";
import { draftOpening } from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import {
  stores,
  sponsor,
  feePayer,
  reserveSponsor,
  world,
  fakeChain,
  settings,
  addressOf,
  approve,
  claimFor,
  opening,
  create,
  orderFor,
  send,
  useDisposableDatabase,
  walletTestLayer,
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

          yield* opening(claim, approve(draft.request, key));

          const recovery = yield* opening(claim);
          const repeated = yield* opening(claim);

          expect(repeated).toEqual(recovery);
          expect(recovery).toBeInstanceOf(RecoveryDraft);
          expect(
            (yield* Directory.use((directory) =>
              directory.byAddress(claim.address),
            )).pipe(Option.map((row) => row.status)),
          ).toEqual(Option.some("opening"));

          assertTagged(recovery, "RecoveryDraft");

          expect(
            yield* opening(claim, approve(recovery.request, Keypair.random())),
          ).toEqual(recovery);
          expect(
            yield* opening(claim, approve(recovery.request, key)),
          ).toBeInstanceOf(Opened);
          expect(world.submitted).toHaveLength(1);
        }),
    );

    it.effect(
      "missing account and missing trustline reopen with the same username and key",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = yield* create(key, "maria");

          for (const missing of ["account", "trustline"]) {
            if (missing === "account") world.accounts.delete(claim.address);
            else
              world.accounts.set(claim.address, {
                sequence: "2000",
                ledger: 100,
                accountSponsored: true,
                sponsored: true,
                nativeBalance: 0n,
                balance: Option.none(),
              });

            expect(
              yield* Wallet.use((wallet) => wallet.overview(claim.address)),
            ).toBeInstanceOf(NeedsReopening);
            expect(
              (yield* Directory.use((directory) =>
                directory.byAddress(claim.address),
              )).pipe(Option.map((row) => row.status)),
            ).toEqual(Option.some("recovered"));
            yield* create(key, "maria");
            expect(
              yield* Wallet.use((wallet) => wallet.overview(claim.address)),
            ).toBeInstanceOf(Holding);
          }
        }),
    );

    it.effect(
      "a sealed opening outside RPC history redrafts after the ledger passes maxTime",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");

          const row = yield* Directory.use((directory) =>
            directory.start(claim.address),
          );

          const now = Math.floor(Date.now() / 1000);

          const envelope = draftOpening({
            source: new Account(reserveSponsor, "100"),
            address: claim.address,
            createAccount: true,
            minTime: now - 200,
            maxTime: now - 80,
          });

          const inner = TransactionBuilder.fromXDR(envelope, networkPassphrase);

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
            hash: Array.from(outer.hash(), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
            expiresAt: DateTime.makeUnsafe((now - 80) * 1000),
          });

          expect(
            yield* Directory.use((directory) =>
              directory.seal(row, historical, claim),
            ),
          ).not.toBeInstanceOf(UsernameTaken);

          const retry = yield* opening(claim);

          expect(retry).toBeInstanceOf(OpeningDraft);
          expect(world.submitted).toHaveLength(0);
          expect(
            Option.getOrThrow(
              yield* Directory.use((directory) =>
                directory.byAddress(claim.address),
              ),
            ).attemptHash,
          ).toBeNull();
        }),
    );

    it.effect(
      "one missing RPC observation does not demote an active wallet",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = yield* create(key, "maria");
          let reads = 0;

          const transient = Layer.effect(
            Chain,
            Effect.gen(function* () {
              const real = yield* Chain;

              return Chain.of({
                ...real,
                account: (address) => {
                  reads++;

                  return reads === 1
                    ? Effect.succeed(Option.none())
                    : real.account(address);
                },
              });
            }),
          ).pipe(Layer.provide(fakeChain));

          const transientWallet = Wallet.serviceLayer.pipe(
            Layer.provide(stores),
            Layer.provide(transient),
            Layer.provide(settings),
          );

          const result = yield* Wallet.use((wallet) =>
            wallet.overview(claim.address),
          ).pipe(Effect.provide(Layer.fresh(transientWallet)));

          expect(result).toBeInstanceOf(Holding);
          expect(
            Option.getOrThrow(
              yield* Directory.use((directory) =>
                directory.byAddress(claim.address),
              ),
            ).status,
          ).toBe("active");
        }),
    );

    it.effect(
      "unsponsored and differently sponsored accounts never receive recovery drafts",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");

          world.accounts.set(claim.address, {
            sequence: "1000",
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("0")),
            ledger: 100,
            accountSponsored: false,
            sponsored: false,
          });
          expect(yield* opening(claim)).toBeInstanceOf(NotSponsored);
          expect(
            Option.isNone(
              yield* Directory.use((directory) =>
                directory.byAddress(claim.address),
              ),
            ),
          ).toBe(true);
          world.accounts.set(claim.address, {
            sequence: "1000",
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("0")),
            ledger: 100,
            accountSponsored: true,
            sponsored: false,
          });
          expect(yield* opening(claim)).toBeInstanceOf(NotSponsored);
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

          expect(yield* opening(claim)).toBeInstanceOf(InvalidAddress);
          expect(
            yield* Wallet.use((wallet) => wallet.overview(bad)),
          ).toBeInstanceOf(InvalidAddress);
          expect(
            Option.isNone(
              yield* Directory.use((directory) => directory.byAddress(bad)),
            ),
          ).toBe(true);
          expect(
            yield* send(orderFor(key, AddressRecipient.make({ value: bad }))),
          ).toBeInstanceOf(InvalidAddress);
          expect(world.submitted).toHaveLength(0);
        }),
    );
  },
);
