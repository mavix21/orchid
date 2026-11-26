import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Asset,
  HeldFundsId,
  Failed,
  Pending,
  PositiveAmount,
  Profile,
  ResolvedRecipient,
  Settled,
  SigningRequest,
  TransferId,
  TransferOrder,
} from "../contract";
import { Sealed } from "./Chain.server";
import type { transfers } from "./tables.server";

export const ClaimableKind = Schema.Literals(["username", "paymentLink"]);

export type ClaimableKind = typeof ClaimableKind.Type;

export class Proposed extends Schema.TaggedClass<Proposed>()("Proposed", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  request: SigningRequest,
  heldFunds: Schema.optional(HeldFundsId),
  claimableKind: Schema.optional(ClaimableKind),
  attemptHeldFunds: Schema.Array(HeldFundsId),
}) {}

export class Authorized extends Schema.TaggedClass<Authorized>()("Authorized", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  sealed: Sealed,
  heldFunds: Schema.optional(HeldFundsId),
  claimableKind: Schema.optional(ClaimableKind),
  attemptHeldFunds: Schema.Array(HeldFundsId),
}) {}

export class Concluded extends Schema.TaggedClass<Concluded>()("Concluded", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  receipt: Schema.Union([Settled, Failed]),
}) {}

export class SlotTaken extends Schema.TaggedClass<SlotTaken>()("SlotTaken", {
  holder: Authorized,
}) {}

export class ClaimablesFull extends Schema.TaggedClass<ClaimablesFull>()(
  "ClaimablesFull",
  { limit: Schema.Number },
) {}

export class OpenHeldFunds extends Schema.Class<OpenHeldFunds>("OpenHeldFunds")(
  {
    id: HeldFundsId,
    from: Profile,
    to: Profile,
  },
) {}

export class OpenLinkRecord extends Schema.Class<OpenLinkRecord>(
  "OpenLinkRecord",
)({
  id: TransferId,
  heldFunds: HeldFundsId,
  address: AccountAddress,
  asset: Asset,
  amount: PositiveAmount,
  createdAt: Schema.DateTimeUtcFromString,
}) {}

export class FundedLink extends Schema.Class<FundedLink>("FundedLink")({
  heldFunds: HeldFundsId,
  sender: Profile,
  asset: Asset,
  amount: PositiveAmount,
}) {}

export type Transfer = Proposed | Authorized | Concluded;

export type TransferRow = typeof transfers.$inferSelect;

export interface ConclusionColumns {
  readonly status: "settled" | "failed";
  readonly concludedAt: Date;
  readonly failure: "expired" | "rejected" | null;
}

export const OrderJson = Schema.fromJsonString(TransferOrder);
export const RecipientJson = Schema.fromJsonString(ResolvedRecipient);
export const AttemptsJson = Schema.fromJsonString(Schema.Array(HeldFundsId));

export const claimableKindOf = (
  order: TransferOrder,
  heldFunds: Option.Option<HeldFundsId>,
): ClaimableKind | null =>
  Option.isNone(heldFunds)
    ? null
    : Predicate.isTagged(order.to, "PaymentLink")
      ? "paymentLink"
      : "username";

export const appendAttempt = (
  existing: ReadonlyArray<HeldFundsId>,
  heldFunds: Option.Option<HeldFundsId>,
): ReadonlyArray<HeldFundsId> =>
  Option.match(heldFunds, {
    onNone: () => existing,
    onSome: (id) => (existing.includes(id) ? existing : [...existing, id]),
  });

export function pending(transfer: Authorized): Pending {
  return new Pending({
    ...transfer.order,
    recipient: transfer.recipient,
    heldFunds: transfer.heldFunds,
    expiresAt: transfer.sealed.expiresAt,
  });
}

export function readTransferRow(row: TransferRow): Transfer {
  const order = Schema.decodeSync(OrderJson)(row.order);
  const recipient = Schema.decodeSync(RecipientJson)(row.resolvedRecipient);
  const expiresAt = DateTime.makeUnsafe(row.expiresAt);

  const heldFunds =
    row.balanceId === null
      ? undefined
      : Schema.decodeSync(HeldFundsId)(row.balanceId);

  const claimableKind =
    row.claimableKind === null
      ? heldFunds === undefined
        ? undefined
        : Predicate.isTagged(order.to, "PaymentLink")
          ? "paymentLink"
          : "username"
      : Schema.decodeSync(ClaimableKind)(row.claimableKind);

  const attemptHeldFunds =
    row.attemptBalanceIds === null
      ? heldFunds === undefined
        ? []
        : [heldFunds]
      : Schema.decodeSync(AttemptsJson)(row.attemptBalanceIds);

  const fields = {
    order,
    recipient,
    heldFunds,
    claimableKind,
    attemptHeldFunds,
  };

  return Match.value(row.status).pipe(
    Match.when(
      "proposed",
      () =>
        new Proposed({
          ...fields,
          request: new SigningRequest({
            envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
              row.envelope,
            ),
            expiresAt,
          }),
        }),
    ),
    Match.when("authorized", () => {
      if (!row.hash) throw new Error("Authorized transfer missing hash");

      return new Authorized({
        ...fields,
        sealed: new Sealed({
          envelope: row.envelope,
          hash: row.hash,
          expiresAt,
        }),
      });
    }),
    Match.when("settled", () => {
      if (!row.concludedAt)
        throw new Error("Settled transfer missing ledger time");

      return new Concluded({
        order,
        recipient,
        receipt: new Settled({
          ...order,
          recipient,
          heldFunds,
          settledAt: DateTime.makeUnsafe(row.concludedAt),
        }),
      });
    }),
    Match.when("failed", () => {
      if (!row.failure) throw new Error("Failed transfer missing reason");

      return new Concluded({
        order,
        recipient,
        receipt: new Failed({
          ...order,
          recipient,
          heldFunds,
          reason: row.failure,
        }),
      });
    }),
    Match.exhaustive,
  );
}
