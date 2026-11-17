import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "../src/contract";
import { KnownExchangeMemo, exchangeMemoFor } from "../src/server/exchange-memos.server";
import { network } from "../src/stellar/network";

test("memo requirements match exact registered addresses and retain source evidence", () => {
  const address = Schema.decodeSync(AccountAddress)(Keypair.random().publicKey());
  const other = Schema.decodeSync(AccountAddress)(Keypair.random().publicKey());

  const entry = new KnownExchangeMemo({
    network,
    address,
    exchange: "Synthetic exchange fixture",
    source: "https://example.com/fixtures/stellar-testnet-memo-required",
  });

  expect(exchangeMemoFor(address, [entry])).toEqual(Option.some(entry));
  expect(Option.isNone(exchangeMemoFor(other, [entry]))).toBe(true);
  expect(Option.isNone(exchangeMemoFor(address))).toBe(true);
});

test("registry entries require testnet, checksum-valid addresses and a public HTTPS source", () => {
  const valid = Keypair.random().publicKey();

  const entry = {
    network,
    address: valid,
    exchange: "Synthetic exchange fixture",
    source: "https://example.com/fixtures/stellar-testnet-memo-required",
  };

  const bad = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;

  for (const invalid of [
    { ...entry, network: "mainnet" },
    { ...entry, address: bad },
    { ...entry, source: "" },
    { ...entry, source: "file:///not-public" },
    { ...entry, exchange: "" },
  ])
    expect(Option.isNone(Schema.decodeUnknownOption(KnownExchangeMemo)(invalid))).toBe(true);
});
