import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const RpcRequest = Schema.fromJsonString(
  Schema.Struct({
    params: Schema.Struct({ keys: Schema.Array(Schema.String) }),
  }),
);

export const rpcAnswering = (reply: (keys: ReadonlyArray<string>) => string) =>
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
