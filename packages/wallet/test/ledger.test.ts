import { createServer } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as Schema from "effect/Schema";
import { fetchEntries } from "../src/server/ledger.server";

const RpcRequest = Schema.fromJsonString(
  Schema.Struct({
    params: Schema.Struct({ keys: Schema.Array(Schema.String) }),
  }),
);

const strictRpc = createServer((request, response) => {
  let body = "";

  request.on("data", (chunk) => {
    body += String(chunk);
  });

  request.on("end", () => {
    const { keys } = Schema.decodeSync(RpcRequest)(body).params;

    response.setHeader("Content-Type", "application/json");
    response.end(
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
  });
});

it("asks the ledger RPC for each repeated key only once", async () => {
  await new Promise<void>((resolve) => strictRpc.listen(0, resolve));

  const bound = Schema.decodeUnknownSync(
    Schema.Struct({ port: Schema.Number }),
  )(strictRpc.address());

  const account = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.random().xdrAccountId(),
    }),
  );

  try {
    expect(
      await fetchEntries(`http://127.0.0.1:${bound.port}`, [account, account]),
    ).toEqual({ entries: [], latestLedger: 7 });
  } finally {
    await new Promise((resolve) => strictRpc.close(resolve));
  }
});
