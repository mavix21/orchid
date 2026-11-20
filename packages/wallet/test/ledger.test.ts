import { createServer } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fetchEntries } from "../src/server/ledger.server";

const RpcRequest = Schema.fromJsonString(
  Schema.Struct({
    params: Schema.Struct({ keys: Schema.Array(Schema.String) }),
  }),
);

const rpcAnswering = (reply: (keys: ReadonlyArray<string>) => string) =>
  Effect.acquireRelease(
    Effect.promise(() => {
      const server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk) => {
          body += String(chunk);
        });

        request.on("end", () => {
          response.setHeader("Content-Type", "application/json");
          response.end(reply(Schema.decodeSync(RpcRequest)(body).params.keys));
        });
      });

      return new Promise<typeof server>((resolve) =>
        server.listen(0, () => resolve(server)),
      );
    }),
    (server) =>
      Effect.promise(
        () => new Promise((resolve) => server.close(() => resolve(true))),
      ),
  ).pipe(
    Effect.map(
      (server) =>
        `http://127.0.0.1:${
          Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
            server.address(),
          ).port
        }`,
    ),
  );

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
