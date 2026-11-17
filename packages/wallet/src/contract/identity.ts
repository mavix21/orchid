import * as Schema from "effect/Schema";

/** Lowercase, 3 to 20 of a–z 0–9 underscore. The "@" is display only. */
export const Username = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_]{3,20}$/),
).pipe(Schema.brand("Username"));

export type Username = typeof Username.Type;

/** A Stellar account address. Syntax only; the checksum is verified where the SDK is loaded. */
export const AccountAddress = Schema.String.check(
  Schema.isPattern(/^G[A-Z2-7]{55}$/),
).pipe(Schema.brand("AccountAddress"));

export type AccountAddress = typeof AccountAddress.Type;

export class Profile extends Schema.Class<Profile>("@workspace/wallet/Profile")(
  {
    username: Username,
    address: AccountAddress,
  },
) {}
