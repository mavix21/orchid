import { Asset as StellarAsset } from "@stellar/stellar-sdk";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type Asset,
  AssetCode,
  IssuedAsset,
  NativeAsset,
} from "../contract";

export function toStellarAsset(asset: Asset): StellarAsset {
  return Match.valueTags(asset, {
    Native: () => StellarAsset.native(),
    Issued: ({ code, issuer }) => new StellarAsset(code, issuer),
  });
}

export function fromStellarAsset(asset: StellarAsset): Asset {
  return asset.isNative()
    ? NativeAsset.make({})
    : IssuedAsset.make({
        code: Schema.decodeSync(AssetCode)(asset.code),
        issuer: Schema.decodeUnknownSync(AccountAddress)(asset.issuer),
      });
}
