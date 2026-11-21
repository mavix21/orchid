import { expect, it } from "@effect/vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { AccountAddress } from "../src/contract";
import { ChainUnreachable } from "../src/server/chain-errors.server";
import {
  KnownExchangeMemo,
  memoRequirementFor,
} from "../src/server/exchange-memos.server";
import { stellarRpc } from "../src/server/ledger.server";
import { defaultRpcTimeout } from "../src/server/settings.server";
import { network } from "../src/stellar/network";
import { rpcAnswering, rpcError, rpcOk, testRpcUrl } from "./rpc-answering";

const checkMemo = (
  address: AccountAddress,
  entries: ReadonlyArray<KnownExchangeMemo>,
) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    memoRequirementFor(
      stellarRpc(client, testRpcUrl, defaultRpcTimeout),
      address,
      entries,
    ),
  );

const ledgerPublishing = (
  address: AccountAddress,
  memoRequired: Option.Option<Uint8Array>,
) =>
  rpcAnswering((keys) => {
    const accountId = Keypair.fromPublicKey(address).xdrAccountId();

    const requested = xdr.LedgerKey.data(
      new xdr.LedgerKeyData({ accountId, dataName: "config.memo_required" }),
    ).toXdr("base64");

    return rpcOk({
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
    });
  });

const randomAddress = () =>
  Schema.decodeSync(AccountAddress)(Keypair.random().publicKey());

it.effect(
  "registered addresses answer without the ledger, and others fail while unreachable",
  () =>
    Effect.gen(function* () {
      const address = randomAddress();

      const entry = new KnownExchangeMemo({
        network,
        address,
        exchange: "Synthetic exchange fixture",
        source: "https://example.com/fixtures/stellar-testnet-memo-required",
      });

      const http = rpcAnswering(() => rpcError);

      expect(
        yield* checkMemo(address, [entry]).pipe(Effect.provide(http)),
      ).toEqual(Option.some(entry));
      expect(
        yield* checkMemo(randomAddress(), [entry]).pipe(
          Effect.provide(http),
          Effect.flip,
        ),
      ).toBeInstanceOf(ChainUnreachable);
    }),
);

const published = (text: string) => Option.some(new TextEncoder().encode(text));

it.effect.each([
  { name: "no entry", memoRequired: Option.none(), required: false },
  { name: '"1"', memoRequired: published("1"), required: true },
  { name: '"0"', memoRequired: published("0"), required: false },
  { name: '"11"', memoRequired: published("11"), required: false },
])(
  "an unregistered account publishing $name requires a memo: $required",
  ({ memoRequired, required }) =>
    Effect.gen(function* () {
      const address = randomAddress();

      expect(
        yield* checkMemo(address, []).pipe(
          Effect.provide(ledgerPublishing(address, memoRequired)),
        ),
      ).toEqual(
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
    }),
);

const validEntry = {
  network,
  address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  exchange: "Synthetic exchange fixture",
  source: "https://example.com/fixtures/stellar-testnet-memo-required",
};

it.each([
  { name: "valid entry", entry: validEntry, valid: true },
  {
    name: "non-testnet network",
    entry: { ...validEntry, network: "mainnet" },
    valid: false,
  },
  {
    name: "bad checksum",
    entry: { ...validEntry, address: `${validEntry.address.slice(0, -1)}A` },
    valid: false,
  },
  { name: "empty source", entry: { ...validEntry, source: "" }, valid: false },
  {
    name: "non-HTTPS source",
    entry: { ...validEntry, source: "file:///not-public" },
    valid: false,
  },
  {
    name: "empty exchange",
    entry: { ...validEntry, exchange: "" },
    valid: false,
  },
])("registry decoding for $name is valid: $valid", ({ entry, valid }) => {
  expect(
    Option.isSome(Schema.decodeUnknownOption(KnownExchangeMemo)(entry)),
  ).toBe(valid);
});
