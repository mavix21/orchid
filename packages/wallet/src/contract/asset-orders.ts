import * as Schema from "effect/Schema";
import { SigningRequest } from "./approval";
import { Amount, BalanceId, IssuedAsset } from "./assets";
import { AccountAddress } from "./identity";

/** Minted on the phone with crypto.randomUUID() before any network call. */
export const AssetOrderId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("AssetOrderId"),
);

export type AssetOrderId = typeof AssetOrderId.Type;

/** Opens a trustline whose reserve Orchid sponsors. */
export const OpenTrustline = Schema.TaggedStruct("OpenTrustline", {
  asset: IssuedAsset,
});

/** Removes an empty trustline, which returns its reserve to the sponsor. */
export const CloseTrustline = Schema.TaggedStruct("CloseTrustline", {
  asset: IssuedAsset,
});

/** Claims a balance, opening the sponsored trustline it needs in the same transaction. */
export const ClaimBalance = Schema.TaggedStruct("ClaimBalance", {
  balance: BalanceId,
});

export const AssetAction = Schema.Union([
  OpenTrustline,
  CloseTrustline,
  ClaimBalance,
]);

export type AssetAction = typeof AssetAction.Type;

export class AssetOrder extends Schema.Class<AssetOrder>(
  "@workspace/wallet/AssetOrder",
)({
  id: AssetOrderId,
  wallet: AccountAddress,
  action: AssetAction,
}) {}

const assetOrderFields = {
  id: AssetOrderId,
  action: AssetAction,
};

export class AssetDraft extends Schema.TaggedClass<AssetDraft>()("AssetDraft", {
  request: SigningRequest,
}) {}

/** Signed, stored, on its way. It will become AssetSettled or AssetFailed without the phone. */
export class AssetPending extends Schema.TaggedClass<AssetPending>()(
  "AssetPending",
  {
    ...assetOrderFields,
    expiresAt: Schema.DateTimeUtcFromString,
  },
) {}

export class AssetSettled extends Schema.TaggedClass<AssetSettled>()(
  "AssetSettled",
  {
    ...assetOrderFields,
    settledAt: Schema.DateTimeUtcFromString,
  },
) {}

/** Proven not to have changed the ledger, and proven unable to. */
export class AssetFailed extends Schema.TaggedClass<AssetFailed>()(
  "AssetFailed",
  {
    ...assetOrderFields,
    reason: Schema.Literals(["expired", "rejected"]),
  },
) {}

/** Another asset order of this wallet is signed and unfinished. */
export class AssetBusy extends Schema.TaggedClass<AssetBusy>()("AssetBusy", {
  inFlight: AssetPending,
}) {}

/** The ledger already matches the order: the trustline is already open, or already gone. */
export class Unchanged extends Schema.TaggedClass<Unchanged>()(
  "Unchanged",
  {},
) {}

/** Orchid sponsors at most `limit` trustlines per wallet. Close an empty one first. */
export class TrustlineLimitReached extends Schema.TaggedClass<TrustlineLimitReached>()(
  "TrustlineLimitReached",
  { limit: Schema.Number },
) {}

/** A trustline can be removed only at zero balance. */
export class TrustlineNotEmpty extends Schema.TaggedClass<TrustlineNotEmpty>()(
  "TrustlineNotEmpty",
  { balance: Amount },
) {}

/**
 * - `issuer_missing`: the issuer account does not exist.
 * - `self_issued`: an account cannot trust itself.
 * - `base_asset`: the wallet's opening trustline cannot be removed.
 * - `authorization_required`: the issuer must approve the holder first.
 */
export class AssetUnsupported extends Schema.TaggedClass<AssetUnsupported>()(
  "AssetUnsupported",
  {
    reason: Schema.Literals([
      "issuer_missing",
      "self_issued",
      "base_asset",
      "authorization_required",
    ]),
  },
) {}

/** This wallet is not a claimant, or its claim opens at `claimableAt`. */
export class NotClaimable extends Schema.TaggedClass<NotClaimable>()(
  "NotClaimable",
  { claimableAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString) },
) {}

/** The balance is no longer on the ledger: somebody claimed it. */
export class BalanceGone extends Schema.TaggedClass<BalanceGone>()(
  "BalanceGone",
  {},
) {}
