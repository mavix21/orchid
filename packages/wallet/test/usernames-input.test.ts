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

it("names the first forbidden character and rejects invalid characters at the schema", () => {
  expect(usernameIssue("maria-rojas!")).toEqual(
    Option.some(new ForbiddenCharacter({ character: "-" })),
  );
  expect(usernameIssue("maría")).toEqual(
    Option.some(new ForbiddenCharacter({ character: "í" })),
  );
  expect(usernameIssue("Maria")).toEqual(
    Option.some(new ForbiddenCharacter({ character: "M" })),
  );
  expect(Schema.is(Username)("maria-rojas!")).toBe(false);
  expect(Schema.is(Username)("Maria")).toBe(false);
});

it("enforces username length bounds and valid alphabet at both helper and schema", () => {
  expect(usernameIssue("ma")).toEqual(
    Option.some(new UsernameTooShort({ length: 2 })),
  );
  expect(usernameIssue("a".repeat(21))).toEqual(
    Option.some(new UsernameTooLong({ length: 21 })),
  );
  expect(Schema.is(Username)("ma")).toBe(false);
  expect(Schema.is(Username)("a".repeat(21))).toBe(false);

  for (const valid of ["mar", "maria_99", "a".repeat(20)]) {
    expect(Option.isNone(usernameIssue(valid))).toBe(true);
    expect(Schema.is(Username)(valid)).toBe(true);
  }
});
