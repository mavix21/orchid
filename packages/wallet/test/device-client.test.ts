import { expect, it, layer } from "@effect/vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Holding,
  Opened,
  OpeningDraft,
  RecoveryDraft,
  SigningRequest,
  Username,
  WalletUnavailable,
  type WalletPort,
} from "../src/contract";
import {
  DraftRejected,
  NoWallet,
  SavedWallet,
  makeWalletClient,
} from "../src/device/client";
import { DeviceWallet, type KeyStore } from "../src/device/key-store";
import { SecretPhrase } from "../src/device/secret-phrase";
import { signingKey } from "../src/device/signing";
import { Directory } from "../src/server/Directory.server";
import { Wallet } from "../src/server/Wallet.server";
import { draftOpening, draftRecovery } from "../src/stellar/envelopes";
import {
  addressOf,
  reserveSponsor,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

function memoryKeyStore() {
  let saved = Option.none<DeviceWallet>();

  const store: KeyStore = {
    read: () => Effect.sync(() => saved),
    write: (wallet) =>
      Effect.sync(() => {
        saved = Option.some(wallet);
      }),
  };

  return store;
}

const savedWallet = (store: KeyStore) =>
  store.read().pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);

const walletStatus = (store: KeyStore) =>
  Effect.gen(function* () {
    const wallet = yield* savedWallet(store);

    return (yield* Directory.use((directory) =>
      directory.byAddress(wallet.address),
    )).pipe(Option.map((row) => row.status));
  });

const redraft = (
  request: SigningRequest,
  envelope: SigningRequest["envelope"],
) => new SigningRequest({ envelope, expiresAt: request.expiresAt });

it("derives the Stellar account of a SEP-5 secret phrase", () => {
  const key = signingKey(
    Schema.decodeSync(SecretPhrase)(
      "illness spike retreat truth genius clock brain pass fit cave bargain toe",
    ),
  );

  expect(key.publicKey()).toBe(
    "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
  );
  expect(key.secret()).toBe(
    "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN",
  );
});

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "creates a wallet whose key never leaves the device and reads its overview",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const store = memoryKeyStore();
          const client = makeWalletClient(wallet, store);

          expect(yield* Effect.promise(() => client.overview())).toEqual(
            new NoWallet(),
          );

          const created = yield* Effect.promise(() => client.create("maria"));
          const saved = yield* savedWallet(store);

          expect(created).toBeInstanceOf(Opened);
          expect(created instanceof Opened && created.profile.address).toBe(
            saved.address,
          );
          expect(saved.address).toBe(signingKey(saved.phrase).publicKey());
          expect(saved.phrase.split(" ")).toHaveLength(12);
          expect(yield* Effect.promise(() => client.overview())).toBeInstanceOf(
            Holding,
          );
        }),
    );

    it.effect(
      "resumes an interrupted opening with the stored key after a reload",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const store = memoryKeyStore();
          let calls = 0;

          const interrupted: WalletPort = {
            ...wallet,
            open: (claim, approval) =>
              ++calls === 3
                ? Effect.fail(
                    new WalletUnavailable({ cause: new Error("Reloaded") }),
                  )
                : wallet.open(claim, approval),
          };

          expect(
            (yield* Effect.promise(() =>
              makeWalletClient(interrupted, store).create("maria"),
            ))._tag,
          ).toBe("Offline");

          const before = yield* savedWallet(store);

          expect(
            yield* Effect.promise(() =>
              makeWalletClient(wallet, store).saved(),
            ),
          ).toEqual(
            new SavedWallet({
              username: Schema.decodeSync(Username)("maria"),
              openingApproved: true,
            }),
          );

          expect(yield* walletStatus(store)).toEqual(Option.some("opening"));

          const resumed = yield* Effect.promise(() =>
            makeWalletClient(wallet, store).create("maria"),
          );

          expect(resumed).toBeInstanceOf(Opened);
          expect((yield* savedWallet(store)).phrase).toBe(before.phrase);
          expect(yield* walletStatus(store)).toEqual(Option.some("active"));
        }),
    );

    it.effect(
      "keeps the username bound by a signed opening when another is typed",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const store = memoryKeyStore();
          let calls = 0;

          const interrupted: WalletPort = {
            ...wallet,
            open: (claim, approval) =>
              ++calls === 3
                ? Effect.fail(
                    new WalletUnavailable({ cause: new Error("Reloaded") }),
                  )
                : wallet.open(claim, approval),
          };

          yield* Effect.promise(() =>
            makeWalletClient(interrupted, store).create("maria"),
          );

          const resumed = yield* Effect.promise(() =>
            makeWalletClient(wallet, store).create("pedro"),
          );

          expect(resumed instanceof Opened && resumed.profile.username).toBe(
            "maria",
          );
          expect((yield* savedWallet(store)).username).toBe("maria");
        }),
    );

    it.effect("refuses an expired opening draft", () =>
      Effect.gen(function* () {
        const wallet = yield* Wallet;
        const store = memoryKeyStore();

        const expired: WalletPort = {
          ...wallet,
          open: (claim, approval) =>
            wallet.open(claim, approval).pipe(
              Effect.map((step) =>
                step instanceof OpeningDraft
                  ? new OpeningDraft({
                      request: new SigningRequest({
                        envelope: step.request.envelope,
                        expiresAt: DateTime.makeUnsafe(Date.now() - 1000),
                      }),
                    })
                  : step,
              ),
            ),
        };

        expect(
          yield* Effect.promise(() =>
            makeWalletClient(expired, store).create("maria"),
          ),
        ).toEqual(new DraftRejected());
        expect(world.submitted).toHaveLength(0);
      }),
    );

    it.effect("refuses an opening drafted for another address", () =>
      Effect.gen(function* () {
        const wallet = yield* Wallet;
        const store = memoryKeyStore();
        const stranger = addressOf(Keypair.random());

        const tampered: WalletPort = {
          ...wallet,
          open: (claim, approval) =>
            wallet.open(claim, approval).pipe(
              Effect.map((step) =>
                step instanceof OpeningDraft
                  ? new OpeningDraft({
                      request: redraft(
                        step.request,
                        draftOpening({
                          source: new Account(reserveSponsor, "100"),
                          address: stranger,
                          createAccount: true,
                          minTime: 0,
                          maxTime: 4_000_000_000,
                        }),
                      ),
                    })
                  : step,
              ),
            ),
        };

        expect(
          yield* Effect.promise(() =>
            makeWalletClient(tampered, store).create("maria"),
          ),
        ).toEqual(new DraftRejected());
        expect(world.submitted).toHaveLength(0);
      }),
    );

    it.effect(
      "refuses a recovery that returns reserves to another sponsor",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const store = memoryKeyStore();
          const impostor = addressOf(Keypair.random());

          const tampered: WalletPort = {
            ...wallet,
            open: (claim, approval) =>
              wallet.open(claim, approval).pipe(
                Effect.map((step) =>
                  step instanceof RecoveryDraft
                    ? new RecoveryDraft({
                        request: redraft(
                          step.request,
                          draftRecovery({
                            source: new Account(
                              claim.address,
                              world.accounts.get(claim.address)?.sequence ??
                                "100",
                            ),
                            reserveSponsor: impostor,
                            minTime: 1,
                            maxTime: 4_000_000_000,
                          }),
                        ),
                      })
                    : step,
                ),
              ),
          };

          expect(
            yield* Effect.promise(() =>
              makeWalletClient(tampered, store).create("maria"),
            ),
          ).toEqual(new DraftRejected());
          expect(yield* walletStatus(store)).toEqual(Option.some("opening"));
        }),
    );
  },
);
