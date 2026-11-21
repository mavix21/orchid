import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const RpcRequest = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.Literal("getLedgerEntries"),
    params: Schema.Struct({ keys: Schema.Array(Schema.String) }),
  }),
);

export const testRpcUrl = "https://rpc.test";

export const requestBodyText = (request: HttpClientRequest.HttpClientRequest) =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? new TextDecoder().decode(request.body.body)
    : "";

export const httpClientAnswering = (
  reply: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      reply(request).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      ),
    ),
  );

export const rpcAnswering = (reply: (keys: ReadonlyArray<string>) => string) =>
  httpClientAnswering((request) =>
    Effect.succeed(
      new Response(
        reply(
          Schema.decodeSync(RpcRequest)(requestBodyText(request)).params.keys,
        ),
        { headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
