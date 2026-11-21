import { Keypair, MuxedAccount, Account } from "@stellar/stellar-sdk";
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

it.each(["12345", "001234", " 12 ", "18446744073709551615", "deposit"])(
  "the memo %j is sent as MEMO_TEXT exactly as typed",
  (memo) => {
    expect(sentMemo(memo)).toEqual(Option.some({ type: "text", value: memo }));
  },
);

it("a memo over 28 UTF-8 bytes is refused even when it is short in characters", () => {
  expect(
    Option.map(Result.getFailure(intentFor("é".repeat(15))), (p) => p.field),
  ).toEqual(Option.some("memo"));
  expect(sentMemo("é".repeat(14))).toEqual(
    Option.some({ type: "text", value: "é".repeat(14) }),
  );
});

it("an empty memo sends no memo", () => {
  expect(Result.getOrThrow(intentFor("")).memo).toBeUndefined();
});

it("a memo is dropped for a muxed address", () => {
  const muxed = new MuxedAccount(
    new Account(destination, "0"),
    "42",
  ).accountId();

  expect(Result.getOrThrow(intentFor("12345", muxed)).memo).toBeUndefined();
});
