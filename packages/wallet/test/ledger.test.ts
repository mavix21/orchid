import { expect, it } from "@effect/vitest";
import { Account, Keypair, xdr } from "@stellar/stellar-sdk";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
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
import {
  ApprovalInvalid,
  Chain,
  SubmissionRejected,
} from "../src/server/Chain.server";
import { ChainUnreachable } from "../src/server/chain-errors.server";
import { stellarRpc } from "../src/server/ledger.server";
import { WalletSettings } from "../src/server/settings.server";
import {
  draftPayment,
  readEnvelope,
  signingPayload,
} from "../src/stellar/envelopes";
import {
  httpClientAnswering,
  requestBodyText,
  rpcAnswering,
  testRpcUrl,
} from "./rpc-answering";
import { assertTagged } from "./tagged";

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

const jsonResponse = (body: string) =>
  new Response(body, {
    headers: { "Content-Type": "application/json" },
  });

const SendTransactionRequest = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.Literal("sendTransaction"),
    params: Schema.Struct({ transaction: Schema.String }),
  }),
);

const GetLedgerEntriesRequest = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.Literal("getLedgerEntries"),
    params: Schema.Struct({ keys: Schema.Array(Schema.String) }),
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

const chainSubmitting = (reply: (transaction: string) => string) =>
  chainFor(
    testRpcUrl,
    httpClientAnswering((request) =>
      Effect.succeed(
        jsonResponse(
          reply(
            Schema.decodeSync(SendTransactionRequest)(requestBodyText(request))
              .params.transaction,
          ),
        ),
      ),
    ),
  );

const accountEntryXdr = (key: Keypair, sequence: bigint) =>
  xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: key.xdrAccountId(),
      balance: 0n,
      seqNum: sequence,
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: new Uint8Array([1, 0, 0, 0]),
      signers: [],
      ext: xdr.AccountEntryExt.v0(),
    }),
  ).toXDR("base64");

const sponsorAccountKey = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: sponsor.xdrPublicKey() }),
).toXDR("base64");

const sealedPayment = Effect.gen(function* () {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

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
      yield* Effect.flatMap(HttpClient.HttpClient, (client) =>
        stellarRpc(client, testRpcUrl, Duration.seconds(10)).entries([
          account,
          account,
        ]),
      ).pipe(Effect.provide(http)),
    ).toEqual({ entries: [], latestLedger: 7 });
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
      yield* Chain.use((chain) => chain.account(address)).pipe(
        Effect.provide(chainFor(testRpcUrl, http)),
        Effect.flip,
      ),
    ).toBeInstanceOf(ChainUnreachable);
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
        jsonResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { entries: [], latestLedger: 7 },
          }),
        ),
      );
    });

    yield* Chain.use((chain) => chain.account(address)).pipe(
      Effect.withSpan("stellar-rpc-check"),
      Effect.provide(chainFor(testRpcUrl, http)),
    );

    expect(seen).toEqual([{ traceparent: undefined, b3: undefined }]);
  }),
);

it.effect.each(["PENDING", "DUPLICATE"])(
  "submit accepts sendTransaction status %s",
  (status) =>
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

it.effect.each([
  {
    name: "TRY_AGAIN_LATER",
    result: { status: "TRY_AGAIN_LATER" },
    tag: "ChainUnreachable",
    code: undefined,
  },
  {
    name: "ERROR with a direct transaction result",
    result: { status: "ERROR", errorResultXdr: txBadSeqXdr },
    tag: "SubmissionRejected",
    code: "txBadSeq",
  },
  {
    name: "ERROR with a fee-bump inner transaction result",
    result: { status: "ERROR", errorResultXdr: feeBumpTooEarlyXdr },
    tag: "SubmissionRejected",
    code: "txTooEarly",
  },
  {
    name: "ERROR with an absent errorResultXdr",
    result: { status: "ERROR" },
    tag: "SubmissionRejected",
    code: undefined,
  },
])("submit rejects $name", ({ result, tag, code }) =>
  Effect.gen(function* () {
    const sealed = yield* sealedPayment;

    const failure = yield* Chain.use((chain) => chain.submit(sealed)).pipe(
      Effect.provide(
        chainSubmitting(() =>
          JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
        ),
      ),
      Effect.flip,
    );

    expect(failure._tag).toBe(tag);
    expect(
      failure instanceof SubmissionRejected ? failure.code : undefined,
    ).toBe(code);
  }),
);

it.effect("submit dies on an unrecognized sendTransaction status", () =>
  Effect.gen(function* () {
    const sealed = yield* sealedPayment;

    const exit = yield* Chain.use((chain) => chain.submit(sealed)).pipe(
      Effect.provide(
        chainSubmitting(() =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "UNKNOWN" },
          }),
        ),
      ),
      Effect.exit,
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  }),
);

it.effect.each([
  {
    name: "response headers stall past the default 10s RPC timeout",
    rpcTimeout: undefined,
    beforeMs: 9_999,
    http: httpClientAnswering(() => Effect.never),
  },
  {
    name: "response body stalls past the default 10s RPC timeout",
    rpcTimeout: undefined,
    beforeMs: 9_999,
    http: httpClientAnswering(() =>
      Effect.succeed(
        new Response(new ReadableStream({ start() {} }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  },
  {
    name: "response stalls past a custom 3s RPC timeout",
    rpcTimeout: Duration.seconds(3),
    beforeMs: 2_999,
    http: httpClientAnswering(() => Effect.never),
  },
])("fails with ChainUnreachable when $name", ({ rpcTimeout, beforeMs, http }) =>
  Effect.gen(function* () {
    const attempt = yield* Chain.use((chain) => chain.account(address)).pipe(
      Effect.provide(chainFor(testRpcUrl, http, rpcTimeout)),
      Effect.flip,
      Effect.forkChild,
    );

    yield* TestClock.adjust(Duration.millis(beforeMs));

    expect(attempt.pollUnsafe()).toBeUndefined();

    yield* TestClock.adjust(Duration.millis(1));

    expect(yield* Fiber.join(attempt)).toBeInstanceOf(ChainUnreachable);
  }),
);

it.effect(
  "draftPayment and seal honor Effect Clock when time advances into the approval margin",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);

      const chainLayer = chainFor(
        testRpcUrl,
        rpcAnswering(() =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              entries: [{ xdr: accountEntryXdr(holder, 123n) }],
              latestLedger: 7,
            },
          }),
        ),
      );

      const draft = yield* Chain.use((chain) =>
        chain.draftPayment(
          address,
          recipient,
          baseAsset,
          Schema.decodeSync(PositiveAmount)("1"),
        ),
      ).pipe(Effect.provide(chainLayer));

      expect(DateTime.toEpochMillis(draft.expiresAt)).toBe(1_700_000_120_000);

      const approval = new Approval({
        signature: holder.sign(signingPayload(draft.envelope)),
      });

      const sealed = yield* Chain.use((chain) =>
        chain.seal(draft, approval, address),
      ).pipe(Effect.provide(chainLayer));

      expect(sealed.expiresAt).toEqual(draft.expiresAt);

      yield* TestClock.adjust("101 seconds");

      expect(
        yield* Chain.use((chain) => chain.seal(draft, approval, address)).pipe(
          Effect.provide(chainLayer),
          Effect.flip,
        ),
      ).toBeInstanceOf(ApprovalInvalid);
    }),
);

it.effect(
  "draftOpening reads sponsor and target account state concurrently",
  () =>
    Effect.gen(function* () {
      const sponsorStarted = yield* Latch.make();
      const targetStarted = yield* Latch.make();

      const chainLayer = chainFor(
        testRpcUrl,
        httpClientAnswering((request) =>
          Effect.gen(function* () {
            const isSponsor = Schema.decodeSync(GetLedgerEntriesRequest)(
              requestBodyText(request),
            ).params.keys.includes(sponsorAccountKey);

            yield* isSponsor ? sponsorStarted.open : targetStarted.open;
            yield* isSponsor ? targetStarted.await : sponsorStarted.await;

            return jsonResponse(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  entries: isSponsor
                    ? [{ xdr: accountEntryXdr(sponsor, 500n) }]
                    : [],
                  latestLedger: 7,
                },
              }),
            );
          }),
        ),
      );

      const draft = yield* Chain.use((chain) =>
        chain.draftOpening(address),
      ).pipe(Effect.provide(chainLayer));

      const facts = Option.getOrThrow(readEnvelope(draft.envelope));

      assertTagged(facts, "OpeningFacts");

      expect(facts.address).toBe(address);
      expect(facts.createAccount).toBe(true);
    }),
);

it.effect.each([
  {
    name: "remote plain HTTP URL",
    rpcUrl: "http://127.0.0.1.example.test",
    rpcTimeout: undefined,
  },
  {
    name: "non-HTTP loopback URL",
    rpcUrl: "ftp://localhost:8000",
    rpcTimeout: undefined,
  },
  {
    name: "infinite rpcTimeout",
    rpcUrl: testRpcUrl,
    rpcTimeout: Duration.infinity,
  },
  {
    name: "zero rpcTimeout",
    rpcUrl: testRpcUrl,
    rpcTimeout: Duration.zero,
  },
  {
    name: "negative rpcTimeout",
    rpcUrl: testRpcUrl,
    rpcTimeout: Duration.millis(-1),
  },
])("Chain rejects $name at construction", ({ rpcUrl, rpcTimeout }) =>
  Effect.gen(function* () {
    const exit = yield* Chain.use((chain) =>
      Effect.succeed(chain.validAddress(address)),
    ).pipe(
      Effect.provide(
        chainFor(
          rpcUrl,
          rpcAnswering(() => ""),
          rpcTimeout,
        ),
      ),
      Effect.exit,
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  }),
);

it.effect.each([
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://[::1]:8000",
])("Chain accepts loopback HTTP RPC URL %s", (rpcUrl) =>
  Effect.gen(function* () {
    expect(
      yield* Chain.use((chain) =>
        Effect.succeed(chain.validAddress(address)),
      ).pipe(
        Effect.provide(
          chainFor(
            rpcUrl,
            rpcAnswering(() => ""),
          ),
        ),
      ),
    ).toBe(true);
  }),
);
