import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { approvalMargin, paymentLifetime } from "../stellar/network";
import type { DraftHandler } from "./draft-handlers";
import { type KeyStore, PublicDeviceWallet } from "./key-store";
import {
  ApprovalOutstanding,
  DraftRejected,
  type SendOutcome,
  UnsupportedDevice,
} from "./outcomes";
import { approve, signingKey } from "./signing";
import {
  approvalOutstanding,
  clockAllowance,
  nextLinkReceipt,
  orderedFacts,
} from "./transfer-drafts";

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

export const uncheckedSigning =
  (store: KeyStore): DraftHandler<SendOutcome> =>
  (wallet, order, draft, finalStep, refreshed) =>
    Effect.gen(function* () {
      const facts = orderedFacts(wallet, order, draft);

      const now = yield* nowSeconds;

      if (
        finalStep ||
        Option.isNone(facts) ||
        approvalOutstanding(wallet, now) ||
        facts.value.maxTime > now + paymentLifetime + clockAllowance
      )
        return { done: Option.some(new DraftRejected()) };

      const deadline = Math.min(
        facts.value.maxTime * 1000,
        DateTime.toEpochMillis(draft.request.expiresAt),
      );

      const withinMargin = Effect.map(
        DateTime.now,
        (current) =>
          deadline - DateTime.toEpochMillis(current) >= approvalMargin * 1000,
      );

      const linkFacts = Predicate.isTagged(facts.value, "PaymentLinkFacts")
        ? facts.value
        : undefined;

      if (!(yield* withinMargin)) {
        if (refreshed) return { done: Option.some(new DraftRejected()) };

        if (linkFacts === undefined)
          return {
            done: Option.none(),
            next: {
              wallet,
              approval: Option.none(),
              refreshed: true,
            },
          };

        const kept = yield* store.updatePublic((current) =>
          current.address === wallet.address &&
          current.transfer?.id === order.id
            ? Option.some(
                new PublicDeviceWallet({
                  ...current,
                  linkReceipt: nextLinkReceipt(current.linkReceipt, linkFacts),
                }),
              )
            : Option.none(),
        );

        if (Option.isNone(kept))
          return { done: Option.some(new UnsupportedDevice()) };

        if (!kept.value.updated)
          return { done: Option.some(new DraftRejected()) };

        return {
          done: Option.none(),
          next: {
            wallet: kept.value.wallet,
            approval: Option.none(),
            refreshed: true,
          },
        };
      }

      const secret = yield* store.read();

      if (Option.isNone(secret) || secret.value.address !== wallet.address)
        return { done: Option.some(new UnsupportedDevice()) };

      if (!(yield* withinMargin))
        return { done: Option.some(new DraftRejected()) };

      const reserveNow = yield* nowSeconds;

      const approved = yield* store.updatePublic((current) =>
        current.address === wallet.address &&
        current.transfer?.id === order.id &&
        !approvalOutstanding(current, reserveNow)
          ? Option.some(
              new PublicDeviceWallet({
                ...current,
                approvedUntil: facts.value.maxTime,
                linkReceipt: linkFacts
                  ? nextLinkReceipt(current.linkReceipt, linkFacts)
                  : current.linkReceipt,
              }),
            )
          : Option.none(),
      );

      if (Option.isNone(approved))
        return { done: Option.some(new UnsupportedDevice()) };

      if (!approved.value.updated) {
        const current = approved.value.wallet;

        return {
          done: Option.some(
            current.address === wallet.address &&
              current.transfer?.id === order.id &&
              approvalOutstanding(current, reserveNow)
              ? new ApprovalOutstanding({ order })
              : new DraftRejected(),
          ),
        };
      }

      if (!(yield* withinMargin))
        return { done: Option.some(new DraftRejected()) };

      return {
        done: Option.none(),
        next: {
          wallet: approved.value.wallet,
          approval: Option.some(
            approve(draft.request, signingKey(secret.value.phrase)),
          ),
          refreshed,
        },
      };
    });
