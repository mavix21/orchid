import { expect, it } from "@effect/vitest";
import { Account, Keypair, xdr } from "@stellar/stellar-sdk";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
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
import { holdingsFromEntries } from "../src/server/ledger-assets.server";
import { stellarRpc } from "../src/server/ledger.server";
import { draftPayment, signingPayload } from "../src/stellar/envelopes";
import { usdc } from "../src/stellar/network";
import {
  accountEntryXdr,
  chainWithHttp,
  httpClientAnswering,
  jsonResponse,
  rpcAnswering,
  rpcError,
  rpcOk,
  submittedTransaction,
  testRpcUrl,
} from "./rpc-answering";

const account = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() }),
);

const holder = Keypair.random();
const address = Schema.decodeSync(AccountAddress)(holder.publicKey());

const recipient = Schema.decodeSync(AccountAddress)(
  Keypair.random().publicKey(),
);

const chainSubmitting = (reply: (tx: string) => string) =>
  chainWithHttp(
    httpClientAnswering((req) =>
      Effect.succeed(jsonResponse(reply(submittedTransaction(req)))),
    ),
  );

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

  return yield* Chain.use((c) =>
    c.seal(
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
      new Set(keys).size === keys.length
        ? rpcOk({ entries: [], latestLedger: 7 })
        : rpcError,
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
  [
    "a transport failure",
    httpClientAnswering((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      ),
    ),
  ],
  [
    "a non-OK HTTP status",
    httpClientAnswering(() =>
      Effect.succeed(new Response("bad gateway", { status: 502 })),
    ),
  ],
] as const)("fails with ChainUnreachable on %s", ([, http]) =>
  Effect.gen(function* () {
    expect(
      yield* Chain.use((c) => c.account(address)).pipe(
        Effect.provide(chainWithHttp(http)),
        Effect.flip,
      ),
    ).toBeInstanceOf(ChainUnreachable);
  }),
);

it.effect("does not propagate trace headers to the Stellar RPC", () =>
  Effect.gen(function* () {
    let headers: { traceparent?: string; b3?: string } | undefined;

    const http = httpClientAnswering((req) => {
      headers = {
        traceparent: req.headers["traceparent"],
        b3: req.headers["b3"],
      };

      return Effect.succeed(
        jsonResponse(rpcOk({ entries: [], latestLedger: 7 })),
      );
    });

    yield* Chain.use((c) => c.account(address)).pipe(
      Effect.withSpan("stellar-rpc-check"),
      Effect.provide(chainWithHttp(http)),
    );
    expect(headers).toEqual({ traceparent: undefined, b3: undefined });
  }),
);

it.effect.each(["PENDING", "DUPLICATE"])(
  "submit accepts sendTransaction status %s",
  (status) =>
    Effect.gen(function* () {
      const sealed = yield* sealedPayment;
      let submitted: string | undefined;

      yield* Chain.use((c) => c.submit(sealed)).pipe(
        Effect.provide(
          chainSubmitting((tx) => {
            submitted = tx;

            return rpcOk({ status, hash: sealed.hash, latestLedger: 100 });
          }),
        ),
      );
      expect(submitted).toBe(sealed.envelope);
    }),
);

it.effect.each([
  [
    "TRY_AGAIN_LATER",
    { status: "TRY_AGAIN_LATER" },
    "ChainUnreachable",
    undefined,
  ],
  [
    "ERROR with a direct transaction result",
    { status: "ERROR", errorResultXdr: txBadSeqXdr },
    "SubmissionRejected",
    "txBadSeq",
  ],
  [
    "ERROR with a fee-bump inner transaction result",
    { status: "ERROR", errorResultXdr: feeBumpTooEarlyXdr },
    "SubmissionRejected",
    "txTooEarly",
  ],
  [
    "ERROR with an absent errorResultXdr",
    { status: "ERROR" },
    "SubmissionRejected",
    undefined,
  ],
] as const)("submit rejects %s", ([, result, tag, code]) =>
  Effect.gen(function* () {
    const sealed = yield* sealedPayment;

    const failure = yield* Chain.use((c) => c.submit(sealed)).pipe(
      Effect.provide(chainSubmitting(() => rpcOk(result))),
      Effect.flip,
    );

    expect(failure._tag).toBe(tag);
    expect(
      failure instanceof SubmissionRejected ? failure.code : undefined,
    ).toBe(code);
  }),
);

const hangingBody = httpClientAnswering(() =>
  Effect.succeed(
    new Response(new ReadableStream({ start() {} }), {
      headers: { "Content-Type": "application/json" },
    }),
  ),
);

const hanging = httpClientAnswering(() => Effect.never);

it.effect.each([
  ["headers stall past default 10s", false, undefined, 9_999, hanging],
  ["body stalls past default 10s", false, undefined, 9_999, hangingBody],
  [
    "sendTransaction stalls past custom 3s",
    true,
    Duration.seconds(3),
    2_999,
    hanging,
  ],
] as const)(
  "fails with ChainUnreachable when %s",
  ([, isSubmit, rpcTimeout, beforeMs, http]) =>
    Effect.gen(function* () {
      const sealed = isSubmit ? yield* sealedPayment : undefined;

      const attempt = yield* Chain.use((c) =>
        sealed ? c.submit(sealed) : c.account(address),
      ).pipe(
        Effect.provide(chainWithHttp(http, { rpcTimeout })),
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
  "seal rejects a once-valid approval after Effect Clock enters the margin",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);

      const chainLayer = chainWithHttp(
        rpcAnswering(() =>
          rpcOk({
            entries: [{ xdr: accountEntryXdr(holder, 123n) }],
            latestLedger: 7,
          }),
        ),
      );

      const draft = yield* Chain.use((c) =>
        c.draftPayment(
          address,
          recipient,
          baseAsset,
          Schema.decodeSync(PositiveAmount)("1"),
        ),
      ).pipe(Effect.provide(chainLayer));

      const approval = new Approval({
        signature: holder.sign(signingPayload(draft.envelope)),
      });

      yield* Chain.use((c) => c.seal(draft, approval, address)).pipe(
        Effect.provide(chainLayer),
      );
      yield* TestClock.adjust("101 seconds");
      expect(
        yield* Chain.use((c) => c.seal(draft, approval, address)).pipe(
          Effect.provide(chainLayer),
          Effect.flip,
        ),
      ).toBeInstanceOf(ApprovalInvalid);
    }),
);

const constructChain = (overrides: {
  readonly rpcUrl?: string;
  readonly rpcTimeout?: Duration.Duration;
}) =>
  Effect.void.pipe(
    Effect.provide(
      chainWithHttp(
        rpcAnswering(() => ""),
        overrides,
      ),
    ),
    Effect.exit,
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
    name: "unbounded rpcTimeout",
    rpcUrl: testRpcUrl,
    rpcTimeout: Duration.infinity,
  },
  {
    name: "nonpositive rpcTimeout",
    rpcUrl: testRpcUrl,
    rpcTimeout: Duration.zero,
  },
])("Chain rejects $name at construction", ({ rpcUrl, rpcTimeout }) =>
  Effect.gen(function* () {
    const exit = yield* constructChain({ rpcUrl, rpcTimeout });

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  }),
);

it.effect.each([
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://[::1]:8000",
])("Chain accepts loopback RPC URL %s at construction", (rpcUrl) =>
  Effect.gen(function* () {
    const exit = yield* constructChain({ rpcUrl });

    expect(Exit.isSuccess(exit)).toBe(true);
  }),
);

it.each([
  ["no liabilities", 1_000n, 300n, 0n, 700n],
  ["buying liabilities", 100n, 0n, 90n, 10n],
  ["balance and buying liabilities", 1_000n, 300n, 90n, 610n],
  ["buying liabilities above the headroom", 100n, 60n, 90n, 0n],
])(
  "incoming capacity of a trustline with %s",
  (_name, limit, balance, buying, capacity) => {
    const key = Keypair.random();

    const line = xdr.LedgerEntryData.trustline(
      new xdr.TrustLineEntry({
        accountId: key.xdrPublicKey(),
        asset: usdc.toTrustLineXdrObject(),
        balance,
        limit,
        flags: 1,
        ext: xdr.TrustLineEntryExt.v1(
          new xdr.TrustLineEntryV1({
            liabilities: new xdr.Liabilities({ buying, selling: 0n }),
            ext: xdr.TrustLineEntryV1Ext.v0(),
          }),
        ),
      }),
    ).toXDR("base64");

    const holdings = holdingsFromEntries(
      [{ xdr: accountEntryXdr(key, 1n, 1) }, { xdr: line }],
      100,
      Keypair.random().publicKey(),
      Schema.decodeSync(AccountAddress)(key.publicKey()),
      [baseAsset],
    );

    expect(
      Option.getOrThrow(holdings).lines.map((entry) => entry.capacity),
    ).toEqual([capacity]);
  },
);
