import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Asset,
  BalanceId,
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
  claimable: Schema.optional(BalanceId),
  claimableKind: Schema.optional(ClaimableKind),
  attemptBalances: Schema.Array(BalanceId),
}) {}

export class Authorized extends Schema.TaggedClass<Authorized>()("Authorized", {
  order: TransferOrder,
  recipient: ResolvedRecipient,
  sealed: Sealed,
  claimable: Schema.optional(BalanceId),
  claimableKind: Schema.optional(ClaimableKind),
  attemptBalances: Schema.Array(BalanceId),
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

export class OpenBalance extends Schema.Class<OpenBalance>("OpenBalance")({
  balance: BalanceId,
  from: Profile,
  to: Profile,
}) {}

export class OpenLinkRecord extends Schema.Class<OpenLinkRecord>(
  "OpenLinkRecord",
)({
  id: TransferId,
  balance: BalanceId,
  address: AccountAddress,
  asset: Asset,
  amount: PositiveAmount,
  createdAt: Schema.DateTimeUtcFromString,
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
export const AttemptsJson = Schema.fromJsonString(Schema.Array(BalanceId));

export const claimableKindOf = (
  order: TransferOrder,
  balance: Option.Option<BalanceId>,
): ClaimableKind | null =>
  Option.isNone(balance)
    ? null
    : Predicate.isTagged(order.to, "PaymentLink")
      ? "paymentLink"
      : "username";

export const appendAttempt = (
  existing: ReadonlyArray<BalanceId>,
  balance: Option.Option<BalanceId>,
): ReadonlyArray<BalanceId> =>
  Option.match(balance, {
    onNone: () => existing,
    onSome: (id) => (existing.includes(id) ? existing : [...existing, id]),
  });

export function pending(transfer: Authorized): Pending {
  return new Pending({
    ...transfer.order,
    recipient: transfer.recipient,
    claimable: transfer.claimable,
    expiresAt: transfer.sealed.expiresAt,
  });
}

export function readTransferRow(row: TransferRow): Transfer {
  const order = Schema.decodeSync(OrderJson)(row.order);
  const recipient = Schema.decodeSync(RecipientJson)(row.resolvedRecipient);
  const expiresAt = DateTime.makeUnsafe(row.expiresAt);

  const claimable =
    row.balanceId === null
      ? undefined
      : Schema.decodeSync(BalanceId)(row.balanceId);

  const claimableKind =
    row.claimableKind === null
      ? claimable === undefined
        ? undefined
        : Predicate.isTagged(order.to, "PaymentLink")
          ? "paymentLink"
          : "username"
      : Schema.decodeSync(ClaimableKind)(row.claimableKind);

  const attemptBalances =
    row.attemptBalanceIds === null
      ? claimable === undefined
        ? []
        : [claimable]
      : Schema.decodeSync(AttemptsJson)(row.attemptBalanceIds);

  const fields = {
    order,
    recipient,
    claimable,
    claimableKind,
    attemptBalances,
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
          claimable,
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
          claimable,
          reason: row.failure,
        }),
      });
    }),
    Match.exhaustive,
  );
}
