import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AssetFailed,
  AssetOrder,
  AssetPending,
  AssetSettled,
  IssuedAsset,
  SigningRequest,
} from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import { Sealed } from "./Chain.server";
import type { assetOrders } from "./tables.server";

export class AssetProposed extends Schema.TaggedClass<AssetProposed>()(
  "AssetProposed",
  {
    order: AssetOrder,
    request: SigningRequest,
  },
) {}

export class AssetAuthorized extends Schema.TaggedClass<AssetAuthorized>()(
  "AssetAuthorized",
  {
    order: AssetOrder,
    sealed: Sealed,
  },
) {}

export class AssetConcluded extends Schema.TaggedClass<AssetConcluded>()(
  "AssetConcluded",
  {
    order: AssetOrder,
    receipt: Schema.Union([AssetSettled, AssetFailed]),
  },
) {}

export type StoredAssetOrder = AssetProposed | AssetAuthorized | AssetConcluded;

export type AssetOrderRow = typeof assetOrders.$inferSelect;

export interface ConclusionColumns {
  readonly status: "settled" | "failed";
  readonly concludedAt: Date;
  readonly failure: "expired" | "rejected" | null;
}

export const AssetOrderJson = Schema.fromJsonString(AssetOrder);
export const OpensJson = Schema.fromJsonString(IssuedAsset);

export function assetPending(order: AssetAuthorized): AssetPending {
  return new AssetPending({
    id: order.order.id,
    action: order.order.action,
    expiresAt: order.sealed.expiresAt,
  });
}

export function readRow(row: AssetOrderRow): StoredAssetOrder {
  const order = Schema.decodeSync(AssetOrderJson)(row.order);
  const expiresAt = DateTime.makeUnsafe(row.expiresAt);
  const fields = { id: order.id, action: order.action };

  return Match.value(row.status).pipe(
    Match.when(
      "proposed",
      () =>
        new AssetProposed({
          order,
          request: new SigningRequest({
            envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
              row.envelope,
            ),
            expiresAt,
          }),
        }),
    ),
    Match.when("authorized", () => {
      if (!row.hash) throw new Error("Authorized asset order missing hash");

      return new AssetAuthorized({
        order,
        sealed: new Sealed({
          envelope: row.envelope,
          hash: row.hash,
          expiresAt,
        }),
      });
    }),
    Match.when("settled", () => {
      if (!row.concludedAt)
        throw new Error("Settled asset order missing ledger time");

      return new AssetConcluded({
        order,
        receipt: new AssetSettled({
          ...fields,
          settledAt: DateTime.makeUnsafe(row.concludedAt),
        }),
      });
    }),
    Match.when("failed", () => {
      if (!row.failure) throw new Error("Failed asset order missing reason");

      return new AssetConcluded({
        order,
        receipt: new AssetFailed({ ...fields, reason: row.failure }),
      });
    }),
    Match.exhaustive,
  );
}

export function opensOf(request: SigningRequest): string | null {
  const facts = readEnvelope(request.envelope);

  return Option.isSome(facts) &&
    Predicate.isTagged(facts.value, "ClaimFacts") &&
    facts.value.opens
    ? Schema.encodeSync(OpensJson)(facts.value.opens)
    : null;
}
