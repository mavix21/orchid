import * as Effect from "effect/Effect";
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
import { ClaimableFacts } from "../stellar/asset-envelopes";
import { PaymentFacts, readEnvelope } from "../stellar/envelopes";
import { approvalMargin } from "../stellar/network";
import {
  DeviceWallet,
  type KeyStore,
  type KeyStoreUnavailable,
  remember,
} from "./key-store";
import {
  DraftRejected,
  NoWallet,
  type SendOutcome,
  type TransferIntent,
  UnsupportedDevice,
} from "./outcomes";
import { pendingPause, pendingSteps } from "./polling";
import { approve, liveFor, signingKey } from "./signing";

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

const matchesOrder = (
  wallet: DeviceWallet,
  order: TransferOrder,
  draft: TransferDraft,
) => {
  const facts = readEnvelope(draft.request.envelope);
  const to = destination(order, draft);

  if (Option.isNone(facts) || Option.isNone(to)) return false;

  const moves =
    (facts.value instanceof PaymentFacts ||
      facts.value instanceof ClaimableFacts) &&
    facts.value.from === wallet.address &&
    facts.value.to === to.value &&
    assetKey(facts.value.asset) === assetKey(order.asset) &&
    facts.value.amount === order.amount;

  if (facts.value instanceof PaymentFacts)
    return moves && sameMemo(facts.value.memo, order.memo);

  if (facts.value instanceof ClaimableFacts)
    return (
      moves &&
      order.memo === undefined &&
      facts.value.reserveSponsor === wallet.reserveSponsor
    );

  return false;
};

export function sendTransfer(port: WalletPort, store: KeyStore) {
  const forget = (order: TransferOrder) =>
    Effect.gen(function* () {
      const stored = yield* store.read();

      if (Option.isSome(stored) && stored.value.transfer?.id === order.id)
        yield* store.write(
          new DeviceWallet({ ...stored.value, transfer: undefined }),
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
          if (remaining === 0 || !matchesOrder(wallet, order, draft))
            return new DraftRejected();

          if (yield* liveFor(draft.request, approvalMargin))
            return yield* advance(
              wallet,
              order,
              Option.some(approve(draft.request, signingKey(wallet.phrase))),
              remaining,
              refreshed,
            );

          return refreshed
            ? new DraftRejected()
            : yield* advance(wallet, order, Option.none(), remaining, true);
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
          new DeviceWallet({ ...wallet, transfer: order }),
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
