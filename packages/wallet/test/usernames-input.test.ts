import { expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ForbiddenCharacter,
  Username,
  UsernameTooLong,
  UsernameTooShort,
  usernameIssue,
} from "../src/contract";

it("names the first character a username cannot contain", () => {
  expect(usernameIssue("maria-rojas")).toEqual(
    Option.some(new ForbiddenCharacter({ character: "-" })),
  );
  expect(usernameIssue("maría")).toEqual(
    Option.some(new ForbiddenCharacter({ character: "í" })),
  );
  expect(usernameIssue("Maria")).toEqual(
    Option.some(new ForbiddenCharacter({ character: "M" })),
  );
});

it("reports usernames outside the length limits", () => {
  expect(usernameIssue("maria_rojas_de_la_paz")).toEqual(
    Option.some(new UsernameTooLong({ length: 21 })),
  );
  expect(usernameIssue("ma")).toEqual(
    Option.some(new UsernameTooShort({ length: 2 })),
  );
});

it("accepts exactly the usernames the Username schema accepts", () => {
  for (const text of [
    "",
    "ma",
    "mar",
    "maria_99",
    "a".repeat(20),
    "a".repeat(21),
    "maria rojas",
    "MARIA",
  ])
    expect(Option.isNone(usernameIssue(text))).toBe(Schema.is(Username)(text));
});
