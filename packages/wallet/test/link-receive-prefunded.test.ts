import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssetOrder,
  AssetOrderId,
  ExternalLinkOrder,
  ReceiveLink,
} from "../src/contract";
import { readEnvelope } from "../src/stellar/envelopes";
import { fundLink } from "./link-fixtures";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  approve,
  fundHolder,
  fundedWallet,
  settleHash,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "a link receive into a wallet claims a link account funded by a third party, redrafting a draft made before the funding, and cleans it up",
      () =>
        Effect.gen(function* () {
          const { wallet, link, balance } = yield* fundLink("prefundedfunder");
          const recipient = yield* fundedWallet("prefundedreceiver");

          const receive = new AssetOrder({
            id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
            wallet: addressOf(recipient),
            action: ReceiveLink.make({ link: addressOf(link), balance }),
          });

          const created = yield* wallet.manage(receive, Option.none());

          assertTagged(created, "AssetDraft");
          world.accounts.set(addressOf(link), accountState());

          const submissionsBefore = world.submitted.length;

          const stale = yield* wallet.manage(
            receive,
            approve(created.request, link),
          );

          assertTagged(stale, "AssetDraft");
          expect(world.submitted).toHaveLength(submissionsBefore);

          const staleFacts = Option.getOrThrow(
            readEnvelope(created.request.envelope),
          );

          const redraftedFacts = Option.getOrThrow(
            readEnvelope(stale.request.envelope),
          );

          assertTagged(staleFacts, "LinkReceiveFacts");
          assertTagged(redraftedFacts, "LinkReceiveFacts");
          expect([
            staleFacts.createsLinkAccount,
            redraftedFacts.createsLinkAccount,
          ]).toEqual([true, false]);

          const released = yield* wallet.manage(
            receive,
            approve(stale.request, link),
          );

          assertTagged(released, "AssetPending");

          for (const sealed of world.submitted.slice(submissionsBefore))
            settleHash(sealed.hash);

          world.claimables.delete(balance);

          expect((yield* wallet.manage(receive, Option.none()))._tag).toBe(
            "AssetSettled",
          );
          expect(world.accounts.has(addressOf(link))).toBe(false);
        }),
    );

    it.effect(
      "an external link claim reuses a link account funded by a third party and cleans it up",
      () =>
        Effect.gen(function* () {
          const { wallet, link, balance } = yield* fundLink("prefundedextfund");
          const external = Keypair.random();

          fundHolder(external);
          world.accounts.set(addressOf(link), accountState());

          const claim = new ExternalLinkOrder({
            id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
            link: addressOf(link),
            balance,
            destination: addressOf(external),
          });

          const drafted = yield* wallet.claimPaymentLink(claim, Option.none());

          assertTagged(drafted, "ExternalLinkDraft");

          const facts = Option.getOrThrow(
            readEnvelope(drafted.request.envelope),
          );

          assertTagged(facts, "LinkReceiveFacts");
          expect(facts.createsLinkAccount).toBe(false);

          const submissionsBefore = world.submitted.length;

          const released = yield* wallet.claimPaymentLink(
            claim,
            approve(drafted.request, link),
          );

          assertTagged(released, "ExternalLinkPending");

          for (const sealed of world.submitted.slice(submissionsBefore))
            settleHash(sealed.hash);

          world.claimables.delete(balance);

          expect(
            (yield* wallet.claimPaymentLink(claim, Option.none()))._tag,
          ).toBe("ExternalLinkSettled");
          expect(world.accounts.has(addressOf(link))).toBe(false);
        }),
    );
  },
);
