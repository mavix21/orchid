import { expect, it } from "@effect/vitest";
import { Account, Keypair, xdr } from "@stellar/stellar-sdk";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as TestClock from "effect/testing/TestClock";
import {
  AccountAddress,
  Approval,
  PositiveAmount,
  SigningRequest,
  baseAsset,
} from "../src/contract";
import { Chain, SubmissionRejected } from "../src/server/Chain.server";
import { ChainUnreachable } from "../src/server/chain-errors.server";
import { stellarRpc } from "../src/server/ledger.server";
import {
  WalletSettings,
  defaultRpcTimeout,
} from "../src/server/settings.server";
import { draftPayment, signingPayload } from "../src/stellar/envelopes";
import {
  httpClientAnswering,
  requestBodyText,
  rpcAnswering,
  testRpcUrl,
} from "./rpc-answering";

const account = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() }),
);

const holder = Keypair.random();
const sponsor = Keypair.random();
const feePayer = Keypair.random();
const address = Schema.decodeSync(AccountAddress)(holder.publicKey());

const recipient = Schema.decodeSync(AccountAddress)(
  Keypair.random().publicKey(),
);

const SendTransactionRequest = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.Literal("sendTransaction"),
    params: Schema.Struct({ transaction: Schema.String }),
  }),
);

const chainFor = (
  rpcUrl: string,
  http: Layer.Layer<HttpClient.HttpClient>,
  rpcTimeout?: Duration.Input,
) =>
  Chain.layer.pipe(
    Layer.provide(
      Layer.succeed(
        WalletSettings,
        rpcTimeout === undefined
          ? {
              rpcUrl,
              reserveSponsorSecret: Redacted.make(sponsor.secret()),
              feePayerSecret: Redacted.make(feePayer.secret()),
              passkeyOrigins: [],
            }
          : {
              rpcUrl,
              rpcTimeout,
              reserveSponsorSecret: Redacted.make(sponsor.secret()),
              feePayerSecret: Redacted.make(feePayer.secret()),
              passkeyOrigins: [],
            },
      ),
    ),
    Layer.provide(http),
  );

const fetchEntries = (
  rpcUrl: string,
  keys: ReadonlyArray<xdr.LedgerKey>,
  timeout: Duration.Duration = defaultRpcTimeout,
) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    stellarRpc(client, rpcUrl, timeout).entries(keys),
  );

const chainSubmitting = (reply: (transaction: string) => string) =>
  chainFor(
    testRpcUrl,
    httpClientAnswering((request) =>
      Effect.succeed(
        new Response(
          reply(
            Schema.decodeSync(SendTransactionRequest)(requestBodyText(request))
              .params.transaction,
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    ),
  );

const sealedPayment = Effect.gen(function* () {
  const now = Math.floor(Date.now() / 1000);

  const envelope = draftPayment({
    asset: baseAsset,
    source: new Account(address, "123"),
    to: recipient,
    amount: Schema.decodeSync(PositiveAmount)("1"),
    minTime: now,
    maxTime: now + 120,
  });

  return yield* Chain.use((chain) =>
    chain.seal(
      new SigningRequest({
        envelope,
        expiresAt: DateTime.makeUnsafe((now + 120) * 1000),
      }),
      new Approval({ signature: holder.sign(signingPayload(envelope)) }),
      address,
    ),
  ).pipe(Effect.provide(chainSubmitting(() => "")));
});

const txBadSeqXdr = new xdr.TransactionResult({
  feeCharged: 100n,
  result: xdr.TransactionResultResult.txBadSeq(),
  ext: xdr.TransactionResultExt.v0(),
}).toXDR("base64");

const feeBumpTooEarlyXdr = new xdr.TransactionResult({
  feeCharged: 200n,
  result: xdr.TransactionResultResult.txFeeBumpInnerFailed(
    new xdr.InnerTransactionResultPair({
      transactionHash: new Uint8Array(32),
      result: new xdr.InnerTransactionResult({
        feeCharged: 100n,
        result: xdr.InnerTransactionResultResult.txTooEarly(),
        ext: xdr.TransactionResultExt.v0(),
      }),
    }),
  ),
  ext: xdr.TransactionResultExt.v0(),
}).toXDR("base64");

it.effect("asks the ledger RPC for each repeated key only once", () =>
  Effect.gen(function* () {
    const http = rpcAnswering((keys) =>
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

    expect(
      yield* fetchEntries(testRpcUrl, [account, account]).pipe(
        Effect.provide(http),
      ),
    ).toEqual({
      entries: [],
      latestLedger: 7,
    });
  }),
);

it.effect.each([
  {
    name: "a transport failure",
    http: httpClientAnswering((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      ),
    ),
  },
  {
    name: "a non-OK HTTP status",
    http: httpClientAnswering(() =>
      Effect.succeed(new Response("bad gateway", { status: 502 })),
    ),
  },
])("fails with ChainUnreachable on $name", ({ http }) =>
  Effect.gen(function* () {
    expect(
      yield* fetchEntries(testRpcUrl, [account]).pipe(
        Effect.provide(http),
        Effect.flip,
      ),
    ).toBeInstanceOf(ChainUnreachable);
  }),
);

it.effect.each([
  { name: "malformed JSON", body: "{not json" },
  {
    name: "a schema mismatch",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { entries: "no" } }),
  },
])("dies on $name from the RPC", ({ body }) =>
  Effect.gen(function* () {
    const http = httpClientAnswering(() =>
      Effect.succeed(
        new Response(body, { headers: { "Content-Type": "application/json" } }),
      ),
    );

    const exit = yield* fetchEntries(testRpcUrl, [account]).pipe(
      Effect.provide(http),
      Effect.exit,
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  }),
);

it.effect("does not propagate trace headers to the Stellar RPC", () =>
  Effect.gen(function* () {
    const seen: Array<{ traceparent?: string; b3?: string }> = [];

    const http = httpClientAnswering((request) => {
      seen.push({
        traceparent: request.headers["traceparent"],
        b3: request.headers["b3"],
      });

      return Effect.succeed(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { entries: [], latestLedger: 7 },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    yield* fetchEntries(testRpcUrl, [account]).pipe(
      Effect.withSpan("stellar-rpc-check"),
      Effect.provide(http),
    );

    expect(seen).toEqual([{ traceparent: undefined, b3: undefined }]);
  }),
);

it.live.each([{ status: "PENDING" }, { status: "DUPLICATE" }])(
  "submit accepts sendTransaction status $status",
  ({ status }) =>
    Effect.gen(function* () {
      const sealed = yield* sealedPayment;
      const submitted: Array<string> = [];

      const chainLayer = chainSubmitting((transaction) => {
        submitted.push(transaction);

        return JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { status, hash: sealed.hash, latestLedger: 100 },
        });
      });

      yield* Chain.use((chain) => chain.submit(sealed)).pipe(
        Effect.provide(chainLayer),
      );

      expect(submitted).toEqual([sealed.envelope]);
    }),
);

it.live("submit fails with ChainUnreachable on TRY_AGAIN_LATER", () =>
  Effect.gen(function* () {
    const sealed = yield* sealedPayment;

    const chainLayer = chainSubmitting(() =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "TRY_AGAIN_LATER", hash: sealed.hash },
      }),
    );

    expect(
      yield* Chain.use((chain) => chain.submit(sealed)).pipe(
        Effect.provide(chainLayer),
        Effect.flip,
      ),
    ).toBeInstanceOf(ChainUnreachable);
  }),
);

it.live.each([
  {
    name: "a direct transaction result",
    result: { status: "ERROR", errorResultXdr: txBadSeqXdr },
    expected: new SubmissionRejected({ code: "txBadSeq" }),
  },
  {
    name: "a fee-bump inner transaction result",
    result: { status: "ERROR", errorResultXdr: feeBumpTooEarlyXdr },
    expected: new SubmissionRejected({ code: "txTooEarly" }),
  },
  {
    name: "an absent errorResultXdr",
    result: { status: "ERROR" },
    expected: new SubmissionRejected({}),
  },
])(
  "submit fails with SubmissionRejected on ERROR with $name",
  ({ result, expected }) =>
    Effect.gen(function* () {
      const sealed = yield* sealedPayment;

      const chainLayer = chainSubmitting(() =>
        JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      );

      expect(
        yield* Chain.use((chain) => chain.submit(sealed)).pipe(
          Effect.provide(chainLayer),
          Effect.flip,
        ),
      ).toEqual(expected);
    }),
);

it.live("submit dies on an unrecognized sendTransaction status", () =>
  Effect.gen(function* () {
    const sealed = yield* sealedPayment;

    const chainLayer = chainSubmitting(() =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "UNKNOWN" } }),
    );

    const exit = yield* Chain.use((chain) => chain.submit(sealed)).pipe(
      Effect.provide(chainLayer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  }),
);

it.effect.each([
  {
    name: "response headers",
    http: httpClientAnswering(() => Effect.never),
  },
  {
    name: "response body",
    http: httpClientAnswering(() =>
      Effect.succeed(
        new Response(new ReadableStream({ start() {} }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  },
])(
  "fails with ChainUnreachable when $name stall past the default 10s RPC timeout",
  ({ http }) =>
    Effect.gen(function* () {
      const attempt = yield* Chain.use((chain) => chain.account(address)).pipe(
        Effect.provide(chainFor(testRpcUrl, http)),
        Effect.flip,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.millis(9_999));

      expect(attempt.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(Duration.millis(1));

      expect(yield* Fiber.join(attempt)).toBeInstanceOf(ChainUnreachable);
    }),
);

it.effect(
  "submit fails with ChainUnreachable and does not resubmit when sendTransaction times out",
  () =>
    Effect.gen(function* () {
      const sealed = yield* sealedPayment;
      const submitted: Array<string> = [];

      const chainLayer = chainFor(
        testRpcUrl,
        httpClientAnswering((request) => {
          submitted.push(
            Schema.decodeSync(SendTransactionRequest)(requestBodyText(request))
              .params.transaction,
          );

          return Effect.never;
        }),
        "3 seconds",
      );

      const attempt = yield* Chain.use((chain) => chain.submit(sealed)).pipe(
        Effect.provide(chainLayer),
        Effect.flip,
        Effect.forkChild,
      );

      yield* TestClock.adjust("2 seconds");

      expect(attempt.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(attempt)).toBeInstanceOf(ChainUnreachable);
      expect(submitted).toEqual([sealed.envelope]);
    }),
);

it.effect.each([
  { name: "remote plain HTTP", rpcUrl: "http://soroban-testnet.stellar.org" },
  {
    name: "non-loopback host prefixed with loopback",
    rpcUrl: "http://127.0.0.1.example.test",
  },
  { name: "non-HTTP scheme on loopback", rpcUrl: "ftp://localhost:8000" },
])("Chain rejects $name RPC URL at construction", ({ rpcUrl }) =>
  Effect.gen(function* () {
    const exit = yield* Chain.use((chain) =>
      Effect.succeed(chain.validAddress(address)),
    ).pipe(
      Effect.provide(
        chainFor(
          rpcUrl,
          rpcAnswering(() => ""),
        ),
      ),
      Effect.exit,
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  }),
);

it.effect.each([
  { name: "HTTPS", rpcUrl: "https://soroban-testnet.stellar.org" },
  { name: "localhost HTTP", rpcUrl: "http://localhost:8000" },
  { name: "IPv4 loopback HTTP", rpcUrl: "http://127.0.0.1:8000" },
  { name: "IPv6 loopback HTTP", rpcUrl: "http://[::1]:8000" },
])("Chain accepts $name RPC URL", ({ rpcUrl }) =>
  Effect.gen(function* () {
    const http = rpcAnswering(() =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { entries: [], latestLedger: 7 },
      }),
    );

    expect(
      yield* Chain.use((chain) => chain.account(address)).pipe(
        Effect.provide(chainFor(rpcUrl, http)),
      ),
    ).toEqual(Option.none());
  }),
);

it.effect.each([
  { name: "infinite Duration", rpcTimeout: Duration.infinity },
  { name: "numeric Infinity", rpcTimeout: Number.POSITIVE_INFINITY },
  { name: "zero Duration", rpcTimeout: Duration.zero },
  { name: "negative Duration", rpcTimeout: Duration.millis(-1) },
  { name: "NaN", rpcTimeout: Number.NaN },
])("Chain rejects $name rpcTimeout at construction", ({ rpcTimeout }) =>
  Effect.gen(function* () {
    const exit = yield* Chain.use((chain) =>
      Effect.succeed(chain.validAddress(address)),
    ).pipe(
      Effect.provide(
        chainFor(
          testRpcUrl,
          rpcAnswering(() => ""),
          rpcTimeout,
        ),
      ),
      Effect.exit,
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  }),
);
