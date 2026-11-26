import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type HeldFundsId,
  HeldFundsLimitReached,
  PositiveAmount,
  RecipientCannotReceive,
  TransferOrder,
  UsernameRecipient,
  baseAsset,
} from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { readEnvelope } from "../src/stellar/envelopes";
import {
  activityOf,
  entryFor,
  payUsername,
  username,
} from "./activity-fixtures";
import { assertTagged } from "./tagged";
import { Wallet } from "../src/server/Wallet.server";
import {
  accountState,
  addressOf,
  amount,
  approveOpening,
  claimFor,
  euro,
  euroLine,
  findWallet,
  fundedWallet,
  holdingsFor,
  opening,
  orderFor,
  overviewOf,
  checkRecipient,
  send,
  settleAttempt,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const waiting = (heldFunds: HeldFundsId, holder: AccountAddress) =>
  world.claimables.set(heldFunds, {
    heldFunds,
    asset: baseAsset,
    amount: Schema.decodeSync(PositiveAmount)("10000000"),
    sponsored: true,
    claimants: [new Claimant(holder, Claimant.predicateUnconditional())],
  });

const unopenedWallet = Effect.fn(function* (name: string) {
  const key = Keypair.random();
  const claim = claimFor(key, name);

  yield* Directory.use((directory) =>
    directory.enrollUnopened(claim, () => Effect.void),
  );

  return { key, claim };
});

const refill = (payer: Keypair) => {
  const address = addressOf(payer);

  world.accounts.set(
    address,
    accountState({
      ...world.accounts.get(address),
      balance: Option.some(amount("50000000")),
    }),
  );
};

const openingClaim = (
  draft: Parameters<typeof approveOpening>[1],
): HeldFundsId | undefined => {
  const facts = Option.getOrThrow(readEnvelope(draft.request.envelope));

  assertTagged(facts, "OpeningFacts");

  return facts.claim;
};

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "a payment to an unopened wallet settles as held funds within the sender's limit, and the recipient's overview lists it",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("payer");
          const { claim } = yield* unopenedWallet("newbie");
          const paid = yield* payUsername(sender, "newbie");

          const heldFunds = Option.getOrThrow(
            Option.fromNullishOr(paid.settled.heldFunds),
          );

          waiting(heldFunds, claim.address);

          const overview = yield* overviewOf(claim.address);

          assertTagged(overview, "NotOpened");
          expect(overview.heldFunds.map((entry) => entry.id)).toEqual([
            heldFunds,
          ]);
          expect(
            overview.heldFunds.map((entry) => entry.from.username),
          ).toEqual([username("payer")]);

          refill(sender);

          const second = yield* payUsername(sender, "newbie");

          waiting(
            Option.getOrThrow(Option.fromNullishOr(second.settled.heldFunds)),
            claim.address,
          );

          const third = orderFor(
            sender,
            UsernameRecipient.make({ value: username("newbie") }),
          );

          refill(sender);

          expect(yield* send(third)).toEqual(
            new HeldFundsLimitReached({ limit: 2 }),
          );
        }),
    );

    it.effect.each([
      {
        name: "a wallet whose account is gone but is not unopened",
        arrange: Effect.gen(function* () {
          const sender = yield* fundedWallet("careful");
          const lost = yield* fundedWallet("vanished");

          world.accounts.delete(addressOf(lost));

          return {
            order: orderFor(
              sender,
              UsernameRecipient.make({ value: username("vanished") }),
            ),
            address: addressOf(lost),
          };
        }),
      },
      {
        name: "an unopened wallet when the asset is not the base asset",
        arrange: Effect.gen(function* () {
          const sender = yield* fundedWallet("euroholder");
          const { claim } = yield* unopenedWallet("euroless");
          const holder = addressOf(sender);

          world.holdings.set(
            holder,
            holdingsFor(holder, { lines: [euroLine("50000000")] }),
          );

          return {
            order: new TransferOrder({
              ...orderFor(
                sender,
                UsernameRecipient.make({ value: username("euroless") }),
              ),
              asset: euro,
            }),
            address: claim.address,
          };
        }),
      },
    ])("still refuses a payment to $name", ({ arrange }) =>
      Effect.gen(function* () {
        const { order, address } = yield* arrange;

        expect(yield* send(order)).toEqual(
          new RecipientCannotReceive({
            address,
            reason: "no_account",
            linkable: true,
          }),
        );
      }),
    );

    it.effect(
      "opening an unopened wallet claims its oldest waiting held funds in the same transaction and resumes after approval",
      () =>
        Effect.gen(function* () {
          const first = yield* fundedWallet("firstpayer");
          const second = yield* fundedWallet("secondpayer");
          const { key, claim } = yield* unopenedWallet("arrival");

          const bare = yield* opening(claim);

          assertTagged(bare, "OpeningDraft");
          expect(openingClaim(bare)).toBeUndefined();

          const earlier = yield* payUsername(first, "arrival");

          const oldest = Option.getOrThrow(
            Option.fromNullishOr(earlier.settled.heldFunds),
          );

          waiting(oldest, claim.address);

          const claiming = yield* opening(claim);

          assertTagged(claiming, "OpeningDraft");
          expect(openingClaim(claiming)).toBe(oldest);

          const later = yield* payUsername(second, "arrival");

          const newest = Option.getOrThrow(
            Option.fromNullishOr(later.settled.heldFunds),
          );

          waiting(newest, claim.address);
          expect(yield* opening(claim)).toEqual(claiming);

          world.claimables.delete(oldest);

          const redrafted = yield* opening(claim);

          assertTagged(redrafted, "OpeningDraft");
          expect(openingClaim(redrafted)).toBe(newest);

          const approvals = approveOpening(key, redrafted);

          expect((yield* opening(claim, approvals))._tag).toBe(
            "OpeningPending",
          );

          const inFlight = yield* overviewOf(claim.address);

          assertTagged(inFlight, "NotOpened");
          expect(inFlight.profile).toEqual(
            Option.some(
              expect.objectContaining({ username: username("arrival") }),
            ),
          );
          expect(inFlight.heldFunds.map((entry) => entry.id)).toEqual([newest]);
          assertTagged(
            yield* checkRecipient(
              UsernameRecipient.make({ value: username("arrival") }),
            ),
            "RecipientCheck",
          );

          yield* settleAttempt(claim.address);

          assertTagged(yield* overviewOf(claim.address), "Holding");
          expect(
            (yield* findWallet(claim.address)).pipe(
              Option.map((row) => row.status),
            ),
          ).toEqual(Option.some("active"));

          const received = entryFor(
            yield* activityOf(yield* Wallet, claim.address),
            later.order.id,
          );

          assertTagged(received, "ReceivedActivity");
          expect(received.closedAt).toBeDefined();
        }),
    );
  },
);
