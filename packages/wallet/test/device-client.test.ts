import { expect, it, layer } from "@effect/vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  type Approvals,
  type AccountAddress,
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
  SavedWallet,
  makeWalletEffects,
} from "../src/device/client";
import { signingKey } from "../src/device/signing";
import { Wallet } from "../src/server/Wallet.server";
import {
  draftOpening,
  draftRecovery,
  pinnedSequence,
  signingPayload,
} from "../src/stellar/envelopes";
import { draftOpeningWithRecovery } from "../src/stellar/opening-drafts";
import {
  approvalMargin,
  paymentLifetime,
  recoveryDelay,
  recoveryWindow,
} from "../src/stellar/network";
import {
  addressOf,
  enrolledDeviceWallet,
  memoryKeyStore,
  seededDeviceWallet,
  unusedPort,
} from "./device-fixtures";
import {
  approvingDevice,
  installSealedWallet,
  sealedKeyStore,
} from "./sealed-wallet-fixtures";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  PublicDeviceWallet,
  type SealedKeyStore,
} from "../src/device/key-store";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";
import {
  findWallet,
  passkeyOrigin,
  reserveSponsor,
  settleAttempt,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

const passkeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;
const seeded = seededDeviceWallet(reserveSponsor);
const holderKey = signingKey(seeded.phrase);

it("derives the Stellar account of a SEP-5 secret phrase", () => {
  expect(holderKey.publicKey()).toBe(
    "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
  );
  expect(holderKey.secret()).toBe(
    "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN",
  );
});

const requestUntil = (envelope: SigningRequest["envelope"], maxTime: number) =>
  new SigningRequest({
    envelope,
    expiresAt: DateTime.makeUnsafe(maxTime * 1000),
  });

interface PairedChange {
  readonly address?: AccountAddress;
  readonly ledgers?: number;
  readonly sponsor?: AccountAddress;
  readonly recoverySequence?: bigint;
  readonly recoveryMinLedger?: boolean;
  readonly delay?: number;
  readonly lifetime?: number;
  readonly minLedger?: number;
}

const pairedDraft = (change: PairedChange = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const maxTime = now + (change.lifetime ?? paymentLifetime);
  const address = change.address ?? seeded.address;

  const window = {
    minLedger: change.minLedger ?? 100,
    maxLedger:
      (change.minLedger ?? 100) + (change.ledgers ?? paymentLifetime) + 1,
  };

  const recoveryMinTime = maxTime + (change.delay ?? recoveryDelay);
  const recoveryMaxTime = recoveryMinTime + recoveryWindow;

  return new OpeningDraft({
    request: requestUntil(
      draftOpening({
        source: new Account(reserveSponsor, "100"),
        address,
        createAccount: true,
        minTime: now,
        maxTime,
        window,
      }),
      maxTime,
    ),
    recovery: requestUntil(
      draftRecovery({
        source: new Account(
          address,
          (change.recoverySequence ?? pinnedSequence(window)).toString(),
        ),
        reserveSponsor: change.sponsor ?? reserveSponsor,
        minTime: recoveryMinTime,
        maxTime: recoveryMaxTime,
        minLedger:
          change.recoveryMinLedger === false ? undefined : window.maxLedger,
      }),
      recoveryMaxTime,
    ),
  });
};

it.effect(
  "polls OpeningPending until the paired opening draft arrives and submits valid approvals for both",
  () =>
    Effect.gen(function* () {
      const enrolled = enrolledDeviceWallet();
      const key = signingKey(enrolled.phrase);
      const { auth } = yield* installSealedWallet(enrolled);
      const started = yield* Latch.make();
      let calls = 0;
      let drafted: OpeningDraft | undefined;
      let submitted: Approvals | undefined;

      const port = unusedPort({
        open: (claim, approvals) =>
          started.open.pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((millis): OpenStep => {
              calls += 1;

              if (calls < 3) return new OpeningPending();

              drafted ??= draftOpeningWithRecovery({
                source: new Account(reserveSponsor, "100"),
                address: claim.address,
                reserveSponsor,
                observedSequence: undefined,
                now: Math.floor(millis / 1000),
                latestLedger: 100,
                pinSequence: true,
              });

              if (Option.isSome(approvals)) {
                submitted = approvals.value;

                return new Opened({ profile: new Profile(claim) });
              }

              return drafted;
            }),
          ),
      });

      const client = makeWalletEffects(
        port,
        sealedKeyStore,
        passkeys,
        approvingDevice(auth),
      );

      const attempt = yield* Effect.forkChild(client.reviewOpening("maria"));

      yield* started.await;
      yield* TestClock.adjust("10 seconds");

      const review = yield* Fiber.join(attempt);

      assertTagged(review, "OpeningReview");
      expect(yield* client.confirmOpening(review)).toBeInstanceOf(Opened);
      expect(submitted).toHaveLength(2);
      expect(yield* client.confirmOpening(review)).toEqual(new DraftRejected());

      const requests = [drafted?.request, drafted?.recovery];

      expect(
        requests.map((request, index) =>
          request === undefined
            ? false
            : key.verify(
                signingPayload(request.envelope),
                Buffer.from(submitted?.[index]?.signature ?? []),
              ),
        ),
      ).toEqual([true, true]);
    }),
);

it.effect(
  "confirms into the standalone recovery review when a settled opening needs the fallback",
  () =>
    Effect.gen(function* () {
      const enrolled = enrolledDeviceWallet();
      const { auth } = yield* installSealedWallet(enrolled);

      const port = unusedPort({
        open: (_claim, approvals) =>
          Effect.map(Clock.currentTimeMillis, (millis): OpenStep => {
            const now = Math.floor(millis / 1000);

            if (Option.isSome(approvals))
              return new RecoveryDraft({
                request: requestUntil(
                  draftRecovery({
                    source: new Account(enrolled.address, "100"),
                    reserveSponsor,
                    minTime: now + recoveryDelay,
                    maxTime: now + recoveryDelay + recoveryWindow,
                  }),
                  now + recoveryDelay + recoveryWindow,
                ),
              });

            return draftOpeningWithRecovery({
              source: new Account(reserveSponsor, "100"),
              address: enrolled.address,
              reserveSponsor,
              observedSequence: undefined,
              now,
              latestLedger: 100,
              pinSequence: true,
            });
          }),
      });

      const client = makeWalletEffects(
        port,
        sealedKeyStore,
        passkeys,
        approvingDevice(auth),
      );

      const review = yield* client.reviewOpening("maria");

      assertTagged(review, "OpeningReview");

      const fallback = yield* client.confirmOpening(review);

      assertTagged(fallback, "OpeningReview");
      expect(fallback.draft._tag).toBe("RecoveryDraft");
    }),
);

const pairedAt = (millis: number, address: AccountAddress) =>
  draftOpeningWithRecovery({
    source: new Account(reserveSponsor, "100"),
    address,
    reserveSponsor,
    observedSequence: undefined,
    now: Math.floor(millis / 1000),
    latestLedger: 100,
    pinSequence: true,
  });

const standaloneAt = (millis: number, address: AccountAddress) => {
  const now = Math.floor(millis / 1000);

  return new RecoveryDraft({
    request: requestUntil(
      draftRecovery({
        source: new Account(address, "100"),
        reserveSponsor,
        minTime: now + recoveryDelay,
        maxTime: now + recoveryDelay + recoveryWindow,
      }),
      now + recoveryDelay + recoveryWindow,
    ),
  });
};

it.effect(
  "releases no signature when another tab renamed the wallet after the review was read",
  () =>
    Effect.gen(function* () {
      const enrolled = enrolledDeviceWallet();
      const { auth } = yield* installSealedWallet(enrolled);
      const released: Array<Option.Option<Approvals>> = [];
      let renamed = false;

      const racingStore: SealedKeyStore = {
        ...browserKeyStore,
        updatePublic: (update) =>
          Effect.suspend(() => {
            if (renamed) return Effect.void;

            renamed = true;

            return browserKeyStore.updatePublic((current) =>
              Option.some(
                new PublicDeviceWallet({
                  ...current,
                  username: Schema.decodeSync(Username)("other"),
                }),
              ),
            );
          }).pipe(Effect.andThen(browserKeyStore.updatePublic(update))),
      };

      const port = unusedPort({
        open: (_claim, approvals) =>
          Effect.map(Clock.currentTimeMillis, (millis): OpenStep => {
            released.push(approvals);

            return pairedAt(millis, enrolled.address);
          }),
      });

      const client = makeWalletEffects(
        port,
        sealedKeyStore,
        passkeys,
        approvingDevice(auth, racingStore),
      );

      const review = yield* client.reviewOpening("maria");

      assertTagged(review, "OpeningReview");
      expect(yield* client.confirmOpening(review)).toEqual(new DraftRejected());
      expect(released.filter(Option.isSome)).toHaveLength(0);
    }),
);

it.effect(
  "allows one redraft for a standalone recovery and refuses the next replacement",
  () =>
    Effect.gen(function* () {
      const { auth } = yield* installSealedWallet(seeded);

      const port = unusedPort({
        open: () =>
          Effect.map(Clock.currentTimeMillis, (millis) =>
            standaloneAt(millis, seeded.address),
          ),
      });

      const client = makeWalletEffects(
        port,
        sealedKeyStore,
        passkeys,
        approvingDevice(auth),
      );

      const first = yield* client.reviewOpening("maria");

      assertTagged(first, "OpeningReview");

      const second = yield* client.confirmOpening(first);

      assertTagged(second, "OpeningReview");
      expect(second.redrafted).toBe(true);
      expect(yield* client.confirmOpening(second)).toEqual(new DraftRejected());
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
          createAccount: false,
          minTime: 0,
          maxTime: Math.floor(Date.now() / 1000) + paymentLifetime,
        }),
        expiresAt: DateTime.makeUnsafe(Date.now() - 1000),
      }),
    }),
  ],
  ["an opening with a zero minimum ledger", pairedDraft({ minLedger: 0 })],
  [
    "an unbumped creation",
    new OpeningDraft({
      request: requestUntil(
        draftOpening({
          source: new Account(reserveSponsor, "100"),
          address: seeded.address,
          createAccount: true,
          minTime: Math.floor(Date.now() / 1000),
          maxTime: Math.floor(Date.now() / 1000) + paymentLifetime,
        }),
        Math.floor(Date.now() / 1000) + paymentLifetime,
      ),
    }),
  ],
  [
    "an opening that keeps expiring within the approval margin",
    pairedDraft({ lifetime: approvalMargin - 5 }),
  ],
  [
    "an opening drafted for another address",
    pairedDraft({ address: addressOf(Keypair.random()) }),
  ],
  [
    "an opening whose ledger window is wider than paymentLifetime + 1",
    pairedDraft({ ledgers: paymentLifetime + 1 }),
  ],
  [
    "a paired recovery with the wrong sequence",
    pairedDraft({
      recoverySequence:
        pinnedSequence({
          minLedger: 100,
          maxLedger: 100 + paymentLifetime + 1,
        }) + 1n,
    }),
  ],
  [
    "a paired recovery that returns reserves to another sponsor",
    pairedDraft({ sponsor: addressOf(Keypair.random()) }),
  ],
  [
    "a paired recovery without a minimum ledger",
    pairedDraft({ recoveryMinLedger: false }),
  ],
  [
    "a paired recovery with a short delay",
    pairedDraft({ delay: recoveryDelay - 1 }),
  ],
  [
    "a recovery that returns reserves to another sponsor",
    new RecoveryDraft({
      request: requestUntil(
        draftRecovery({
          source: new Account(seeded.address, "100"),
          reserveSponsor: addressOf(Keypair.random()),
          minTime: Math.floor(Date.now() / 1000) + recoveryDelay,
          maxTime:
            Math.floor(Date.now() / 1000) + recoveryDelay + recoveryWindow,
        }),
        Math.floor(Date.now() / 1000) + recoveryDelay + recoveryWindow,
      ),
    }),
  ],
];

it.live.each(rejectedDrafts)("refuses %s without approving", ([, step]) =>
  Effect.gen(function* () {
    const approvals: Array<Option.Option<Approvals>> = [];

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
    ).reviewOpening("maria");

    expect(outcome).toEqual(new DraftRejected());
    expect(approvals.filter(Option.isSome)).toHaveLength(0);
  }),
);

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "resumes an interrupted opening with the bound username even if another is typed",
      () =>
        Effect.gen(function* () {
          const wallet = yield* Wallet;
          const enrolled = enrolledDeviceWallet("maria");
          const { auth } = yield* installSealedWallet(enrolled);
          const device = approvingDevice(auth);
          let calls = 0;

          const interrupted: WalletPort = {
            ...wallet,
            open: (claim, approvals) =>
              ++calls === 3
                ? Effect.fail(new Offline())
                : wallet.open(claim, approvals),
          };

          const first = makeWalletEffects(
            interrupted,
            sealedKeyStore,
            passkeys,
            device,
          );

          const review = yield* first.reviewOpening("maria");

          assertTagged(review, "OpeningReview");
          expect((yield* first.confirmOpening(review))._tag).toBe("Offline");

          const resumed = makeWalletEffects(
            wallet,
            sealedKeyStore,
            passkeys,
            device,
          );

          expect(yield* resumed.saved()).toEqual(
            new SavedWallet({
              username: Schema.decodeSync(Username)("maria"),
              openingApproved: true,
              backup: "stored",
            }),
          );
          expect(
            (yield* findWallet(enrolled.address)).pipe(
              Option.map((r) => r.status),
            ),
          ).toEqual(Option.some("opening"));

          yield* settleAttempt(enrolled.address);

          const opened = yield* resumed.reviewOpening("pedro");

          expect(opened instanceof Opened && opened.profile.username).toBe(
            "maria",
          );
          expect(
            (yield* findWallet(enrolled.address)).pipe(
              Option.map((r) => r.status),
            ),
          ).toEqual(Option.some("active"));
        }),
    );
  },
);
