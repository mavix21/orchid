import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  Amount,
  type AssessmentStep,
  type DestinationAddress,
  ExternalRecipient,
  InsufficientBalance,
  InvalidAddress,
  LinkRecipient,
  NotOpened,
  PhoneNotSupported,
  type Receipt,
  type ResolvedRecipient,
  SenderBusy,
  TransferAssessment,
  UnknownRecipient,
  assetKey,
} from "../contract";
import { baseAccountOf, isMuxed } from "../stellar/destination";
import { Chain, type ChainUnreachable } from "./Chain.server";
import { type QuotaCheck, claimableQuotaFlow } from "./claimable-quota.server";
import {
  Directory,
  type StoreFailure,
  type WalletRow,
} from "./Directory.server";
import type { KnownExchangeMemo } from "./exchange-memos.server";
import type { Holdings } from "./ledger-assets.server";
import { memoRefusal } from "./memo-refusal.server";
import { type Authorized, Transfers, pending } from "./Transfers.server";
import {
  type DeliveryRoute,
  type TransferTerms,
  deliveryFlow,
  isDeliveryRoute,
  paymentLinkAssetRefusal,
} from "./wallet-delivery.server";

export class Examined extends Data.TaggedClass("Examined")<{
  readonly sender: WalletRow;
  readonly recipient: ResolvedRecipient;
  readonly requirement: Option.Option<KnownExchangeMemo>;
  readonly holdings: Holdings;
  readonly delivery: DeliveryRoute;
}> {}

export interface TransferEffects {
  readonly settle: (
    held: Authorized,
  ) => Effect.Effect<Receipt, StoreFailure | ChainUnreachable>;
  readonly recover: (sender: WalletRow) => Effect.Effect<void, StoreFailure>;
  readonly quota: QuotaCheck;
}

export const transferCheckFlow = Effect.gen(function* () {
  const chain = yield* Chain;
  const directory = yield* Directory;
  const transfers = yield* Transfers;
  const { route } = yield* deliveryFlow;
  const { quotaReached } = yield* claimableQuotaFlow;
  const checkLinkAsset = yield* paymentLinkAssetRefusal;

  const observing: TransferEffects = {
    settle: (held) => Effect.succeed(pending(held)),
    recover: () => Effect.void,
    quota: quotaReached,
  };

  const malformed = (
    terms: TransferTerms,
  ): Option.Option<InvalidAddress | PhoneNotSupported> => {
    if (!chain.validAddress(terms.from))
      return Option.some(new InvalidAddress({ address: terms.from }));

    const invalidRecipient = Match.valueTags(terms.to, {
      Address: ({ value }) =>
        chain.validAddress(value)
          ? Option.none<DestinationAddress>()
          : Option.some(value),
      PaymentLink: ({ value }) =>
        chain.validAddress(value) && value !== terms.from
          ? Option.none<DestinationAddress>()
          : Option.some(value),
      Username: () => Option.none<DestinationAddress>(),
      Phone: () => Option.none<DestinationAddress>(),
    });

    if (Option.isSome(invalidRecipient))
      return Option.some(
        new InvalidAddress({ address: invalidRecipient.value }),
      );

    return Match.valueTags(terms.to, {
      Phone: () => Option.some(new PhoneNotSupported()),
      Username: () => Option.none(),
      Address: () => Option.none(),
      PaymentLink: () => Option.none(),
    });
  };

  const memoRequirement = Effect.fn("Wallet.memoRequirement")(function* (
    recipient: ResolvedRecipient,
  ) {
    return recipient instanceof ExternalRecipient && !isMuxed(recipient.address)
      ? yield* chain.memoRequiredFor(baseAccountOf(recipient.address))
      : Option.none<KnownExchangeMemo>();
  });

  const examine = Effect.fn("Wallet.examineTransfer")(function* (
    terms: TransferTerms,
    effects: TransferEffects,
  ) {
    const sender = yield* directory.byAddress(terms.from);

    if (Option.isNone(sender) || sender.value.status !== "active")
      return new NotOpened();

    const held = yield* transfers.latestFrom(terms.from);

    if (Option.isSome(held) && Predicate.isTagged(held.value, "Authorized")) {
      const receipt = yield* effects.settle(held.value);

      if (Predicate.isTagged(receipt, "Pending"))
        return new SenderBusy({ inFlight: receipt });
    }

    const recipient = yield* Match.valueTags(terms.to, {
      Username: ({ value }) =>
        directory
          .byUsername(value)
          .pipe(
            Effect.map((found): ResolvedRecipient | UnknownRecipient =>
              Option.isSome(found)
                ? found.value
                : new UnknownRecipient({ username: value }),
            ),
          ),
      Address: ({ value }) =>
        isMuxed(value)
          ? Effect.succeed<ResolvedRecipient>(
              new ExternalRecipient({ address: value }),
            )
          : directory
              .byAddress(value)
              .pipe(
                Effect.flatMap(
                  (found): Effect.Effect<ResolvedRecipient, StoreFailure> =>
                    Option.isSome(found) && found.value.status === "active"
                      ? directory.profile(found.value)
                      : Effect.succeed(
                          new ExternalRecipient({ address: value }),
                        ),
                ),
              ),
      PaymentLink: ({ value }) =>
        Effect.succeed<ResolvedRecipient>(
          new LinkRecipient({ kind: "paymentLink", address: value }),
        ),
      Phone: () => Effect.die("Phone was rejected before recipient resolution"),
    });

    if (Predicate.isTagged(recipient, "UnknownRecipient")) return recipient;

    const requirement = yield* memoRequirement(recipient);
    const refusal = memoRefusal(terms, recipient, requirement);

    if (Option.isSome(refusal)) return refusal.value;

    const state = yield* chain.holdings(
      terms.from,
      Match.valueTags(terms.asset, {
        Native: () => [],
        Issued: (asset) => [asset],
      }),
    );

    if (Option.isNone(state)) {
      yield* effects.recover(sender.value);

      return new NotOpened();
    }

    if (recipient instanceof LinkRecipient) {
      const linkRefusal = yield* checkLinkAsset(terms, state.value);

      if (Option.isSome(linkRefusal)) return linkRefusal.value;
    }

    const balance = Match.valueTags(terms.asset, {
      Native: () => state.value.native,
      Issued: (asset) =>
        state.value.lines.find(
          (line) => assetKey(line.asset) === assetKey(asset) && line.authorized,
        )?.spendable ?? Schema.decodeSync(Amount)("0"),
    });

    if (balance < terms.amount)
      return new InsufficientBalance({ available: balance });

    const delivery = yield* route(terms, recipient, effects.quota, state.value);

    if (!isDeliveryRoute(delivery)) return delivery;

    return new Examined({
      sender: sender.value,
      recipient,
      requirement,
      holdings: state.value,
      delivery,
    });
  });

  const assess = Effect.fn("Wallet.assessTransfer")(function* (
    terms: TransferTerms,
  ): Effect.fn.Return<AssessmentStep, StoreFailure | ChainUnreachable> {
    const refusal = malformed(terms);

    if (Option.isSome(refusal)) return refusal.value;

    const examined = yield* examine(terms, observing);

    return examined instanceof Examined
      ? new TransferAssessment({
          recipient: examined.recipient,
          memoRequired: Option.isSome(examined.requirement),
          exchange: Option.map(
            examined.requirement,
            (requirement) => requirement.exchange,
          ),
        })
      : examined;
  });

  return { malformed, memoRequirement, examine, assess };
});
