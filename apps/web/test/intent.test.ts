import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { baseAsset } from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { expect, it } from "vitest";

import { intentOf } from "../src/send/intent";

const destination = Keypair.random().publicKey();

const intentFor = (memo: string, recipient = destination) =>
  intentOf({ recipient, amount: "1", memo }, "address", baseAsset);

const sentMemo = (memo: string) =>
  Option.map(Result.getSuccess(intentFor(memo)), (intent) => intent.memo);

it.each([
  ["12345", "12345"],
  ["001234", "001234"],
  [" 12 ", "12"],
  ["\n 1 2\t", "1 2"],
])("the memo %j is sent as MEMO_TEXT %j", (typed, sent) => {
  expect(sentMemo(typed)).toEqual(Option.some({ type: "text", value: sent }));
});

it("the 28 byte limit is measured in UTF-8 bytes after trimming", () => {
  const fits = `  ${"é".repeat(14)} `;
  const tooLong = `${"é".repeat(14)}a`;

  expect(sentMemo(fits)).toEqual(
    Option.some({ type: "text", value: "é".repeat(14) }),
  );
  expect(
    Option.map(
      Result.getFailure(intentFor(tooLong)),
      (problem) => problem.field,
    ),
  ).toEqual(Option.some("memo"));
});

it("a memo that is empty after trimming sends no memo", () => {
  expect(Result.getOrThrow(intentFor("  ")).memo).toBeUndefined();
});

it("a memo is dropped for a muxed address", () => {
  const muxed = new MuxedAccount(
    new Account(destination, "0"),
    "42",
  ).accountId();

  expect(Result.getOrThrow(intentFor("12345", muxed)).memo).toBeUndefined();
});
