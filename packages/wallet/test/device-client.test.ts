import { expect, it, layer } from "@effect/vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  type Approval,
  Offline,
  type OpenStep,
  Opened,
  OpeningDraft,
  OpeningPending,
  Profile,
  RecoveryDraft,
  SigningRequest,
  Username,
  type WalletPort,
} from "../src/contract";
import {
  DraftRejected,
  NoWallet,
  SavedWallet,
  makeWalletEffects,
} from "../src/device/client";
import { signingKey } from "../src/device/signing";
import { Wallet } from "../src/server/Wallet.server";
import {
  draftOpening,
  draftRecovery,
  signingPayload,
} from "../src/stellar/envelopes";
import {
  addressOf,
  enrolledDeviceWallet,
  knownPhrase,
  memoryKeyStore,
  savedWallet,
  seededDeviceWallet,
  unusedPort,
} from "./device-fixtures";
import { SoftwareAuthenticator } from "./software-authenticator";
import {
  findWallet,
  passkeyOrigin,
  reserveSponsor,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

const passkeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;
const seeded = seededDeviceWallet(reserveSponsor);
const holderKey = signingKey(knownPhrase);
const farFuture = DateTime.makeUnsafe(4_000_000_000_000);

it("derives the Stellar account of a SEP-5 secret phrase", () => {
  expect(holderKey.publicKey()).toBe(
    "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
  );
  expect(holderKey.secret()).toBe(
    "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN",
  );
});

it.effect(
  "polls OpeningPending until RecoveryDraft arrives and submits a valid recovery approval",
  () =>
    Effect.gen(function* () {
      const started = yield* Latch.make();
      let calls = 0;

      const recoveryRequest = new SigningRequest({
        envelope: draftRecovery({
          source: new Account(seeded.address, "100"),
          reserveSponsor,
          minTime: 1,
          maxTime: 4_000_000_000,
        }),
        expiresAt: farFuture,
      });

      const port = unusedPort({
        open: (claim, approval) =>
          started.open.pipe(
            Effect.andThen(
              Effect.sync((): OpenStep => {
                calls += 1;

                if (calls < 3) return new OpeningPending();

                if (
                  Option.isSome(approval) &&
                  holderKey.verify(
                    signingPayload(recoveryRequest.envelope),
                    Buffer.from(approval.value.signature),
                  )
                )
                  return new Opened({ profile: new Profile(claim) });

                return new RecoveryDraft({ request: recoveryRequest });
              }),
            ),
          ),
      });

      const attempt = yield* Effect.forkChild(
        makeWalletEffects(
          port,
          memoryKeyStore(Option.some(seeded)),
          passkeys,
        ).create("maria"),
      );

      yield* started.await;
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(attempt)).toBeInstanceOf(Opened);
    }),
);

const rejectedDrafts: ReadonlyArray<readonly [string, OpenStep]> = [
  [
    "an expired opening draft",
    new OpeningDraft({
      request: new SigningRequest({
        envelope: draftOpening({
          source: new Account(reserveSponsor, "100"),
          address: seeded.address,
          createAccount: true,
          minTime: 0,
          maxTime: 4_000_000_000,
        }),
        expiresAt: DateTime.makeUnsafe(Date.now() - 1000),
      }),
    }),
  ],
  [
    "an opening drafted for another address",
    new OpeningDraft({
      request: new SigningRequest({
        envelope: draftOpening({
          source: new Account(reserveSponsor, "100"),
          address: addressOf(Keypair.random()),
          createAccount: true,
          minTime: 0,
          maxTime: 4_000_000_000,
        }),
        expiresAt: farFuture,
      }),
    }),
  ],
  [
    "a recovery that returns reserves to another sponsor",
    new RecoveryDraft({
      request: new SigningRequest({
        envelope: draftRecovery({
          source: new Account(seeded.address, "100"),
          reserveSponsor: addressOf(Keypair.random()),
          minTime: 1,
          maxTime: 4_000_000_000,
        }),
        expiresAt: farFuture,
      }),
    }),
  ],
];

it.live.each(rejectedDrafts)("refuses %s without approving", ([, step]) =>
  Effect.gen(function* () {
    const approvals: Array<Option.Option<Approval>> = [];

    const port = unusedPort({
      open: (_claim, approval) =>
        Effect.sync(() => {
          approvals.push(approval);

          return step;
        }),
    });

    const outcome = yield* makeWalletEffects(
      port,
      memoryKeyStore(Option.some(seeded)),
      passkeys,
    ).create("maria");

    expect(outcome).toEqual(new DraftRejected());
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "resumes an interrupted opening with the stored phrase and bound username even if another is typed",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;

          expect(
            yield* makeWalletEffects(wallet, memoryKeyStore(), passkeys).create(
              "maria",
            ),
          ).toEqual(new NoWallet());

          const store = memoryKeyStore(Option.some(enrolledDeviceWallet()));
          let calls = 0;

          const interrupted: WalletPort = {
            ...wallet,
            open: (claim, approval) =>
              ++calls === 3
                ? Effect.fail(new Offline())
                : wallet.open(claim, approval),
          };

          expect(
            (yield* makeWalletEffects(interrupted, store, passkeys).create(
              "maria",
            ))._tag,
          ).toBe("Offline");
          const before = yield* savedWallet(store);

          expect(
            yield* makeWalletEffects(wallet, store, passkeys).saved(),
          ).toEqual(
            new SavedWallet({
              username: Schema.decodeSync(Username)("maria"),
              openingApproved: true,
              backup: "stored",
            }),
          );
          expect(
            (yield* findWallet(before.address)).pipe(
              Option.map((r) => r.status),
            ),
          ).toEqual(Option.some("opening"));

          const resumed = yield* makeWalletEffects(
            wallet,
            store,
            passkeys,
          ).create("pedro");

          expect(resumed instanceof Opened && resumed.profile.username).toBe(
            "maria",
          );
          expect((yield* savedWallet(store)).phrase).toBe(before.phrase);
          expect((yield* savedWallet(store)).username).toBe("maria");
          expect(
            (yield* findWallet(before.address)).pipe(
              Option.map((r) => r.status),
            ),
          ).toEqual(Option.some("active"));
        }),
    );
  },
);
