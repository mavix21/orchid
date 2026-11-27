import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AssetOrder, AssetOrderId, ReceiveLink } from "../src/contract";
import { CleanUpReceivedLink } from "../src/server/work-queue.server";
import { assertTagged } from "./tagged";
import {
  fundLink,
  accountState,
  addressOf,
  approve,
  attend,
  fundedWallet,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const receivedLink = Effect.fn(function* (name: string) {
  const { wallet, link, unclaimedFunds } = yield* fundLink(name);
  const recipient = yield* fundedWallet(`${name}rcv`);

  const receive = new AssetOrder({
    id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
    wallet: addressOf(recipient),
    action: ReceiveLink.make({ link: addressOf(link), unclaimedFunds }),
  });

  const drafted = yield* wallet.manage(receive, Option.none());

  assertTagged(drafted, "AssetDraft");

  const fundingSubmissions = world.submitted.length;

  assertTagged(
    yield* wallet.manage(receive, approve(drafted.request, link)),
    "AssetPending",
  );

  for (const sealed of world.submitted.slice(fundingSubmissions))
    settleHash(sealed.hash);

  world.claimables.delete(unclaimedFunds);
  assertTagged(yield* wallet.manage(receive, Option.none()), "AssetSettled");

  return { address: addressOf(link), receive };
});

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "a cleanup message merges a received link account and retries until it is gone",
      () =>
        Effect.gen(function* () {
          const { address, receive } = yield* receivedLink("cleanup");
          const message = new CleanUpReceivedLink({ id: receive.id });

          expect(world.queued).toContainEqual(message);
          world.accounts.set(address, accountState());
          assertTagged(yield* attend(message), "WorkRetry");
          expect(world.accounts.has(address)).toBe(false);
          assertTagged(yield* attend(message, 2), "WorkFinished");
        }),
    );

    it.effect(
      "a received link that cannot be merged does not block the cleanup of newer links",
      () =>
        Effect.gen(function* () {
          const stuck = yield* Effect.forEach(
            ["blockedone", "blockedtwo", "blockedthree", "blockedfour"],
            (name) =>
              Effect.gen(function* () {
                const { address } = yield* receivedLink(name);

                world.unmergeable.add(address);
                world.accounts.set(address, accountState());

                return address;
              }),
          );

          const { address: newest } = yield* receivedLink("blockedfive");

          world.accounts.set(newest, accountState());
          yield* sweep;

          expect(world.accounts.has(newest)).toBe(false);

          for (const address of stuck)
            expect(world.accounts.has(address)).toBe(true);
        }),
    );
  },
);
