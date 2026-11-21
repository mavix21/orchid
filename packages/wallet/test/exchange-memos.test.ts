import { expect, it } from "@effect/vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress } from "../src/contract";
import {
  KnownExchangeMemo,
  memoRequirementFor,
} from "../src/server/exchange-memos.server";
import { network } from "../src/stellar/network";
import { rpcAnswering } from "./rpc-answering";

const ledgerPublishing = (
  address: AccountAddress,
  memoRequired: Option.Option<Uint8Array>,
) =>
  rpcAnswering((keys) => {
    const accountId = Keypair.fromPublicKey(address).xdrAccountId();

    const requested = xdr.LedgerKey.data(
      new xdr.LedgerKeyData({ accountId, dataName: "config.memo_required" }),
    ).toXdr("base64");

    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        latestLedger: 7,
        entries:
          Option.isSome(memoRequired) && keys.includes(requested)
            ? [
                {
                  xdr: xdr.LedgerEntryData.data(
                    new xdr.DataEntry({
                      accountId,
                      dataName: "config.memo_required",
                      dataValue: memoRequired.value,
                      ext: xdr.DataEntryExt.v0(),
                    }),
                  ).toXdr("base64"),
                },
              ]
            : [],
      },
    });
  });

const randomAddress = () =>
  Schema.decodeSync(AccountAddress)(Keypair.random().publicKey());

it.effect(
  "registered addresses require a memo with their registry evidence when the ledger publishes nothing",
  () =>
    Effect.gen(function* () {
      const address = randomAddress();
      const other = randomAddress();

      const entry = new KnownExchangeMemo({
        network,
        address,
        exchange: "Synthetic exchange fixture",
        source: "https://example.com/fixtures/stellar-testnet-memo-required",
      });

      const rpcUrl = yield* ledgerPublishing(address, Option.none());

      expect(yield* memoRequirementFor(rpcUrl, address, [entry])).toEqual(
        Option.some(entry),
      );
      expect(
        Option.isNone(yield* memoRequirementFor(rpcUrl, other, [entry])),
      ).toBe(true);
    }).pipe(Effect.scoped),
);

const published = (text: string) => Option.some(new TextEncoder().encode(text));

it.effect.each([
  {
    name: "no memo_required entry",
    memoRequired: Option.none(),
    required: false,
  },
  { name: 'memo_required "1"', memoRequired: published("1"), required: true },
  { name: 'memo_required "0"', memoRequired: published("0"), required: false },
  {
    name: 'memo_required "11"',
    memoRequired: published("11"),
    required: false,
  },
  {
    name: 'memo_required "true"',
    memoRequired: published("true"),
    required: false,
  },
])(
  "an unregistered account publishing $name requires a memo: $required",
  ({ memoRequired, required }) =>
    Effect.gen(function* () {
      const address = randomAddress();
      const rpcUrl = yield* ledgerPublishing(address, memoRequired);

      expect(yield* memoRequirementFor(rpcUrl, address, [])).toEqual(
        required
          ? Option.some(
              new KnownExchangeMemo({
                network,
                address,
                exchange: "Exchange",
                source: "https://stellar.org/protocol/sep-29",
              }),
            )
          : Option.none(),
      );
    }).pipe(Effect.scoped),
);

it("registry entries require testnet, checksum-valid addresses and a public HTTPS source", () => {
  const valid = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  const entry = {
    network,
    address: valid,
    exchange: "Synthetic exchange fixture",
    source: "https://example.com/fixtures/stellar-testnet-memo-required",
  };

  expect(
    Option.isSome(Schema.decodeUnknownOption(KnownExchangeMemo)(entry)),
  ).toBe(true);

  const bad = `${valid.slice(0, -1)}A`;

  for (const invalid of [
    { ...entry, network: "mainnet" },
    { ...entry, address: bad },
    { ...entry, source: "" },
    { ...entry, source: "file:///not-public" },
    { ...entry, exchange: "" },
  ])
    expect(
      Option.isNone(Schema.decodeUnknownOption(KnownExchangeMemo)(invalid)),
    ).toBe(true);
});
