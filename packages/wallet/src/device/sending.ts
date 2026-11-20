import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  type Approval,
  type PaymentMemo,
  Profile,
  type TransferDraft,
  TransferId,
  TransferOrder,
  type TransferStep,
  type WalletPort,
  type WalletUnavailable,
  assetKey,
} from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import { approvalMargin, paymentLifetime } from "../stellar/network";
import {
  DeviceWallet,
  type KeyStore,
  type KeyStoreUnavailable,
  remember,
} from "./key-store";
import {
  ApprovalOutstanding,
  DraftRejected,
  NoWallet,
  type SendOutcome,
  type TransferIntent,
  UnsupportedDevice,
} from "./outcomes";
import { pendingPause, pendingSteps } from "./polling";
import { approve, signingKey } from "./signing";

const orderJson = Schema.encodeSync(Schema.fromJsonString(TransferOrder));

const sameMemo = (
  drafted: PaymentMemo | undefined,
  ordered: PaymentMemo | undefined,
) => drafted?.type === ordered?.type && drafted?.value === ordered?.value;

const destination = (order: TransferOrder, draft: TransferDraft) =>
  Match.valueTags(order.to, {
    Address: ({ value }) => Option.some(value),
    Username: ({ value }) =>
      draft.recipient instanceof Profile && draft.recipient.username === value
        ? Option.some(draft.recipient.address)
        : Option.none<AccountAddress>(),
    Phone: () => Option.none<AccountAddress>(),
  });

const clockAllowance = 60;

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

const approvalOutstanding = (wallet: DeviceWallet, now: number) =>
  wallet.approvedUntil !== undefined &&
  wallet.approvedUntil + clockAllowance >= now;

const orderedFacts = (
  wallet: DeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
) => {
  const facts = readEnvelope(draft.request.envelope);
  const to = destination(order, draft);

  if (Option.isNone(facts) || Option.isNone(to)) return Option.none();

  const drafted = facts.value;

  if (
    !(
      Predicate.isTagged(drafted, "PaymentFacts") ||
      Predicate.isTagged(drafted, "ClaimableFacts")
    )
  )
    return Option.none();

  const moves =
    drafted.from === wallet.address &&
    drafted.to === to.value &&
    assetKey(drafted.asset) === assetKey(order.asset) &&
    drafted.amount === order.amount;

  const matches = Predicate.isTagged(drafted, "PaymentFacts")
    ? moves && sameMemo(drafted.memo, order.memo)
    : moves &&
      order.memo === undefined &&
      draft.recipient instanceof Profile &&
      drafted.reserveSponsor === wallet.reserveSponsor;

  return matches ? Option.some(drafted) : Option.none();
};

export function sendTransfer(port: WalletPort, store: KeyStore) {
  const forget = (order: TransferOrder) =>
    Effect.gen(function* () {
      const stored = yield* store.read();

      if (Option.isSome(stored) && stored.value.transfer?.id === order.id)
        yield* store.write(
          new DeviceWallet({
            ...stored.value,
            transfer: undefined,
            approvedUntil: undefined,
          }),
        );
    });

  const advance = (
    wallet: DeviceWallet,
    order: TransferOrder,
    approval: Option.Option<Approval>,
    remaining: number,
    refreshed: boolean,
  ): Effect.Effect<SendOutcome, WalletUnavailable | KeyStoreUnavailable> =>
    port
      .transfer(order, approval)
      .pipe(
        Effect.flatMap((step) =>
          respond(
            wallet,
            order,
            step,
            Option.isSome(approval),
            remaining - 1,
            refreshed,
          ),
        ),
      );

  const respond = (
    wallet: DeviceWallet,
    order: TransferOrder,
    step: TransferStep,
    submitted: boolean,
    remaining: number,
    refreshed: boolean,
  ) =>
    Match.valueTags(step, {
      TransferDraft: (draft) =>
        Effect.gen(function* () {
          const facts = orderedFacts(wallet, order, draft);
          const now = yield* nowSeconds;

          if (
            remaining === 0 ||
            Option.isNone(facts) ||
            approvalOutstanding(wallet, now) ||
            facts.value.maxTime > now + paymentLifetime + clockAllowance
          )
            return new DraftRejected();

          const deadline = Math.min(
            facts.value.maxTime * 1000,
            DateTime.toEpochMillis(draft.request.expiresAt),
          );

          const withinMargin = Effect.map(
            DateTime.now,
            (current) =>
              deadline - DateTime.toEpochMillis(current) >=
              approvalMargin * 1000,
          );

          if (!(yield* withinMargin))
            return refreshed
              ? new DraftRejected()
              : yield* advance(wallet, order, Option.none(), remaining, true);

          const approved = yield* remember(
            store,
            new DeviceWallet({ ...wallet, approvedUntil: facts.value.maxTime }),
          );

          if (Option.isNone(approved)) return new UnsupportedDevice();

          if (!(yield* withinMargin)) return new DraftRejected();

          return yield* advance(
            approved.value,
            order,
            Option.some(approve(draft.request, signingKey(wallet.phrase))),
            remaining,
            refreshed,
          );
        }),
      Pending: (pending) =>
        remaining === 0
          ? Effect.succeed(pending)
          : (submitted ? Effect.void : Effect.sleep(pendingPause)).pipe(
              Effect.andThen(
                advance(wallet, order, Option.none(), remaining, refreshed),
              ),
            ),
      Settled: (settled) => forget(order).pipe(Effect.as(settled)),
      Failed: (failed) => forget(order).pipe(Effect.as(failed)),
      NotOpened: Effect.succeed,
      UnknownRecipient: Effect.succeed,
      PhoneNotSupported: Effect.succeed,
      InsufficientBalance: Effect.succeed,
      SenderBusy: Effect.succeed,
      InvalidAddress: Effect.succeed,
      ExternalMemoRequired: Effect.succeed,
      MemoNotAllowed: Effect.succeed,
      RecipientCannotReceive: Effect.succeed,
      ClaimableLimitReached: Effect.succeed,
      AssetBusy: Effect.succeed,
    });

  return Effect.fn("Device.send")(function* (intent: TransferIntent) {
    const stored = yield* store.read();

    if (Option.isNone(stored)) return new NoWallet();

    const wallet = stored.value;
    const kept = wallet.transfer;

    const replayed =
      kept !== undefined &&
      orderJson(kept) ===
        orderJson(
          new TransferOrder({ ...intent, id: kept.id, from: wallet.address }),
        );

    if (!replayed && kept !== undefined && wallet.approvedUntil !== undefined) {
      const signed = yield* port.transfer(kept, Option.none());
      const now = yield* nowSeconds;

      const resolved =
        Predicate.isTagged(signed, "Settled") ||
        Predicate.isTagged(signed, "Failed") ||
        (!Predicate.isTagged(signed, "Pending") &&
          !approvalOutstanding(wallet, now));

      if (!resolved) return new ApprovalOutstanding({ order: kept });
    }

    const order = replayed
      ? kept
      : new TransferOrder({
          ...intent,
          id: Schema.decodeSync(TransferId)(crypto.randomUUID()),
          from: wallet.address,
        });

    const ready = replayed
      ? Option.some(wallet)
      : yield* remember(
          store,
          new DeviceWallet({
            ...wallet,
            transfer: order,
            approvedUntil: undefined,
          }),
        );

    if (Option.isNone(ready)) return new UnsupportedDevice();

    return yield* advance(
      ready.value,
      order,
      Option.none(),
      pendingSteps,
      false,
    );
  });
}
