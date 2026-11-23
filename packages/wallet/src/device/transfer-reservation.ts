import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { TransferOrder } from "../contract";
import {
  type CorruptDeviceWallet,
  type KeyStoreUnavailable,
  PublicDeviceWallet,
  type SealedKeyStore,
} from "./key-store";
import { ApprovalOutstanding, DraftRejected, NoWallet } from "./outcomes";
import { Reserved } from "./reviewed-approval";
import { approvalOutstanding, sameOrderSlot } from "./transfer-drafts";

const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

export const reserveApproval = Effect.fn("Device.reserveApproval")(function* (
  store: SealedKeyStore,
  reviewed: PublicDeviceWallet,
  order: TransferOrder,
  approvedUntil: number,
): Effect.fn.Return<
  Reserved<PublicDeviceWallet> | ApprovalOutstanding | DraftRejected | NoWallet,
  KeyStoreUnavailable | CorruptDeviceWallet
> {
  const now = yield* nowSeconds;

  const committed = yield* store.updatePublic((current) =>
    sameOrderSlot(current, reviewed) && !approvalOutstanding(current, now)
      ? Option.some(new PublicDeviceWallet({ ...current, approvedUntil }))
      : Option.none(),
  );

  if (Option.isNone(committed)) return new NoWallet();

  const current = committed.value.wallet;

  if (committed.value.updated) return new Reserved({ reservation: current });

  return current.transfer?.id === order.id && approvalOutstanding(current, now)
    ? new ApprovalOutstanding({ order })
    : new DraftRejected();
});

export const withdrawReservation = (
  store: SealedKeyStore,
  reservation: PublicDeviceWallet,
  previous: number | undefined,
) =>
  store
    .updatePublic((current) =>
      sameOrderSlot(current, reservation)
        ? Option.some(
            new PublicDeviceWallet({ ...current, approvedUntil: previous }),
          )
        : Option.none(),
    )
    .pipe(Effect.asVoid);
