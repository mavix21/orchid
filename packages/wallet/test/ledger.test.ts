import { expect, it } from "@effect/vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import { fetchEntries } from "../src/server/ledger.server";
import { rpcAnswering } from "./rpc-answering";

const account = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() }),
);

it.effect("asks the ledger RPC for each repeated key only once", () =>
  Effect.gen(function* () {
    const rpcUrl = yield* rpcAnswering((keys) =>
      JSON.stringify(
        new Set(keys).size === keys.length
          ? { jsonrpc: "2.0", id: 1, result: { entries: [], latestLedger: 7 } }
          : {
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32603, message: "could not query captive core" },
            },
      ),
    );

    expect(yield* fetchEntries(rpcUrl, [account, account])).toEqual({
      entries: [],
      latestLedger: 7,
    });
  }).pipe(Effect.scoped),
);
