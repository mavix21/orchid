import { Keypair } from "@stellar/stellar-sdk";
import { baseAsset } from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { expect, it } from "vitest";

import { type MemoType, intentOf } from "../src/send/intent";

const destination = Keypair.random().publicKey();

const memoted = (memo: string, memoType: Option.Option<MemoType>) =>
  intentOf(
    { recipient: destination, amount: "1", memo, memoType },
    "address",
    baseAsset,
  );

const sentMemo = (memo: string, type: MemoType) =>
  Option.map(
    Result.getSuccess(memoted(memo, Option.some(type))),
    (intent) => intent.memo,
  );

const problemField = (memo: string, memoType: Option.Option<MemoType>) =>
  Option.map(
    Result.getFailure(memoted(memo, memoType)),
    (problem) => problem.field,
  );

it.each(["12345", "001234", " 12 ", "18446744073709551615"])(
  "a numeric-looking memo %j chosen as Texto stays text, exactly as typed",
  (memo) => {
    expect(sentMemo(memo, "text")).toEqual(
      Option.some({ type: "text", value: memo }),
    );
  },
);

it.each(["0", "12345", "18446744073709551615"])(
  "the memo %j chosen as ID numérico is sent as an ID",
  (memo) => {
    expect(sentMemo(memo, "id")).toEqual(
      Option.some({ type: "id", value: memo }),
    );
  },
);

it.each(["18446744073709551616", "-1", "1.5", "abc", " 12", "007"])(
  "the memo %j is refused as an ID numérico",
  (memo) => {
    expect(problemField(memo, Option.some("id"))).toEqual(Option.some("memo"));
  },
);

it("a text memo over 28 UTF-8 bytes is refused even when it is short in characters", () => {
  expect(problemField("é".repeat(15), Option.some("text"))).toEqual(
    Option.some("memo"),
  );
  expect(sentMemo("é".repeat(14), "text")).toEqual(
    Option.some({ type: "text", value: "é".repeat(14) }),
  );
});

it("a memo without a chosen type is refused instead of guessed", () => {
  expect(problemField("12345", Option.none())).toEqual(Option.some("memo"));
});

it("an empty memo needs no type", () => {
  expect(Result.isSuccess(memoted("", Option.none()))).toBe(true);
});
