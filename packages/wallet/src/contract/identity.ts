import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const usernameMinLength = 3;
export const usernameMaxLength = 20;

const usernameCharacter = /^[a-z0-9_]$/;

const usernamePattern = new RegExp(
  `^[a-z0-9_]{${usernameMinLength},${usernameMaxLength}}$`,
  "u",
);

export const Username = Schema.String.check(
  Schema.isPattern(usernamePattern),
).pipe(Schema.brand("Username"));

export type Username = typeof Username.Type;

export class ForbiddenCharacter extends Schema.TaggedClass<ForbiddenCharacter>()(
  "ForbiddenCharacter",
  { character: Schema.String },
) {}

export class UsernameTooLong extends Schema.TaggedClass<UsernameTooLong>()(
  "UsernameTooLong",
  { length: Schema.Number },
) {}

export class UsernameTooShort extends Schema.TaggedClass<UsernameTooShort>()(
  "UsernameTooShort",
  { length: Schema.Number },
) {}

export type UsernameIssue =
  | ForbiddenCharacter
  | UsernameTooLong
  | UsernameTooShort;

export function usernameIssue(text: string): Option.Option<UsernameIssue> {
  const characters = Array.from(text);

  const forbidden = characters.find(
    (character) => !usernameCharacter.test(character),
  );

  if (forbidden !== undefined)
    return Option.some(new ForbiddenCharacter({ character: forbidden }));

  if (characters.length > usernameMaxLength)
    return Option.some(new UsernameTooLong({ length: characters.length }));

  if (characters.length < usernameMinLength)
    return Option.some(new UsernameTooShort({ length: characters.length }));

  return Option.none();
}

export const AccountAddress = Schema.String.check(
  Schema.isPattern(/^G[A-Z2-7]{55}$/u),
).pipe(Schema.brand("AccountAddress"));

export type AccountAddress = typeof AccountAddress.Type;

export const MuxedAddress = Schema.String.check(
  Schema.isPattern(/^M[A-Z2-7]{68}$/u),
).pipe(Schema.brand("MuxedAddress"));

export type MuxedAddress = typeof MuxedAddress.Type;

export const DestinationAddress = Schema.Union([AccountAddress, MuxedAddress]);

export type DestinationAddress = typeof DestinationAddress.Type;

export class Profile extends Schema.Class<Profile>("@workspace/wallet/Profile")(
  {
    username: Username,
    address: AccountAddress,
  },
) {}
