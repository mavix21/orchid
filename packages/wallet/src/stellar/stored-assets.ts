import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, Asset, AssetCode, nativeAsset } from "../contract";
import { issuedAsset } from "./assets";

const TaggedAsset = Schema.Union([
  Schema.TaggedStruct("Native", {}),
  Schema.TaggedStruct("Issued", { code: AssetCode, issuer: AccountAddress }),
]);

const decodeTaggedAsset = Schema.decodeUnknownOption(TaggedAsset);

const decodeFields = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Json),
);

const encodeAsset = Schema.encodeSync(Asset);

const identifiedAsset = (stored: Schema.Json): Schema.Json =>
  Option.match(decodeTaggedAsset(stored), {
    onNone: () => stored,
    onSome: (tagged) =>
      encodeAsset(
        Match.valueTags(tagged, {
          Native: () => nativeAsset,
          Issued: ({ code, issuer }) => issuedAsset(code, issuer),
        }),
      ),
  });

const rewriting =
  (field: string, rewrite: (value: Schema.Json) => Schema.Json) =>
  (stored: Schema.Json): Schema.Json =>
    Option.match(decodeFields(stored), {
      onNone: () => stored,
      onSome: (fields) => {
        const value = fields[field];

        return value === undefined
          ? stored
          : { ...fields, [field]: rewrite(value) };
      },
    });

const identifiedHolder = rewriting("asset", identifiedAsset);

const identifiedTransfer = rewriting("transfer", identifiedHolder);

const identifiedReceipt = rewriting("linkReceipt", identifiedHolder);

export const identifyStoredWalletAssets = rewriting("public", (wallet) =>
  identifiedReceipt(identifiedTransfer(wallet)),
);
