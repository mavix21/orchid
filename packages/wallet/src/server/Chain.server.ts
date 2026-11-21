import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import {
  AccountAddress,
  Approval,
  type Asset,
  PaymentMemo,
  PositiveAmount,
  SigningRequest,
  Amount,
} from "../contract";
import {
  draftOpening,
  draftPayment,
  draftRecovery,
  readEnvelope,
} from "../stellar/envelopes";
import {
  approvalMargin,
  baseFee,
  networkPassphrase,
  paymentLifetime,
  recoveryDelay,
  recoveryWindow,
  usdc,
} from "../stellar/network";
import { type AssetChain, assetChain } from "./chain-assets.server";
import { ChainUnreachable } from "./chain-errors.server";
import {
  type AccountState,
  accountFromEntries,
  stellarRpc,
} from "./ledger.server";

export { ChainUnreachable } from "./chain-errors.server";

export type { AccountState } from "./ledger.server";

import {
  type KnownExchangeMemo,
  memoRequirementFor,
} from "./exchange-memos.server";
import { WalletSettings, defaultRpcTimeout } from "./settings.server";

export class Sealed extends Schema.Class<Sealed>("Sealed")({
  envelope: Schema.String,
  hash: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

export class Applied extends Schema.TaggedClass<Applied>()("Applied", {
  at: Schema.DateTimeUtcFromString,
}) {}

export class Rejected extends Schema.TaggedClass<Rejected>()("Rejected", {
  code: Schema.String,
}) {}

export class Expired extends Schema.TaggedClass<Expired>()("Expired", {}) {}

export class Undecided extends Schema.TaggedClass<Undecided>()(
  "Undecided",
  {},
) {}

export type Settlement = Applied | Rejected | Expired | Undecided;

export class ApprovalInvalid extends Schema.TaggedError<ApprovalInvalid>()(
  "ApprovalInvalid",
  {},
) {}

export class SubmissionRejected extends Schema.TaggedError<SubmissionRejected>()(
  "SubmissionRejected",
  {
    code: Schema.optional(Schema.String),
  },
) {}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

const validateRpcUrl = (rpcUrl: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() => new URL(rpcUrl)).pipe(Effect.orDie);

    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname))
    )
      return yield* Effect.die(
        new Error(
          "Stellar RPC URL must use HTTPS unless targeting a loopback host",
        ),
      );

    return rpcUrl;
  });

const validateRpcTimeout = (
  input: Duration.Input | undefined,
): Effect.Effect<Duration.Duration> => {
  if (input === undefined) return Effect.succeed(defaultRpcTimeout);

  const parsed = Duration.fromInput(input);

  if (
    Option.isSome(parsed) &&
    Duration.isFinite(parsed.value) &&
    Duration.isPositive(parsed.value)
  )
    return Effect.succeed(parsed.value);

  return Effect.die(
    new Error("Stellar RPC timeout must be a positive finite duration"),
  );
};

const RawSendTransaction = Schema.Union([
  Schema.Struct({ status: Schema.Literal("PENDING") }),
  Schema.Struct({ status: Schema.Literal("DUPLICATE") }),
  Schema.Struct({ status: Schema.Literal("TRY_AGAIN_LATER") }),
  Schema.Struct({
    status: Schema.Literal("ERROR"),
    errorResultXdr: Schema.optional(Schema.String),
  }),
]);

const resultCode = (transactionResult: xdr.TransactionResult): string => {
  const result = transactionResult.result;

  return result.type === "txFeeBumpInnerFailed"
    ? result.innerResultPair.result.result.type
    : result.type;
};

const lookupWindow = {
  latestLedger: Schema.Number,
  latestLedgerCloseTime: Schema.NumberFromString,
  oldestLedgerCloseTime: Schema.NumberFromString,
};

const RawTransactionLookup = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("SUCCESS"),
    createdAt: Schema.NumberFromString,
    ...lookupWindow,
  }),
  Schema.Struct({
    status: Schema.Literal("FAILED"),
    resultXdr: Schema.String,
    ...lookupWindow,
  }),
  Schema.Struct({ status: Schema.Literal("NOT_FOUND"), ...lookupWindow }),
]);

type LookupWindow = {
  readonly latestLedger: number;
  readonly latestLedgerCloseTime: number;
  readonly oldestLedgerCloseTime: number;
};

export type TransactionLookup =
  | (LookupWindow & { readonly status: "SUCCESS"; readonly createdAt: number })
  | (LookupWindow & {
      readonly status: "FAILED";
      readonly resultXdr: xdr.TransactionResult;
    })
  | (LookupWindow & { readonly status: "NOT_FOUND" });

const transactionLookup = (
  raw: typeof RawTransactionLookup.Type,
): TransactionLookup =>
  raw.status === "FAILED"
    ? {
        ...raw,
        resultXdr: xdr.TransactionResult.fromXDR(raw.resultXdr, "base64"),
      }
    : raw;

export function settlementFromResponse(
  response: TransactionLookup,
  sealed: Sealed,
  sender: Option.Option<AccountState>,
): Settlement {
  if (response.status === "SUCCESS")
    return new Applied({ at: DateTime.makeUnsafe(response.createdAt * 1000) });

  if (response.status === "FAILED") {
    const code = resultCode(response.resultXdr);

    if (code === "txFailed") return new Rejected({ code });
  }

  const envelope = TransactionBuilder.fromXDR(
    sealed.envelope,
    networkPassphrase,
  );

  const inner =
    envelope instanceof FeeBumpTransaction
      ? envelope.innerTransaction
      : envelope;

  const minTime = Number(inner.timeBounds?.minTime);

  if (
    Option.isSome(sender) &&
    sender.value.ledger >= response.latestLedger &&
    BigInt(sender.value.sequence) < BigInt(inner.sequence) &&
    response.oldestLedgerCloseTime <= minTime &&
    response.latestLedgerCloseTime * 1000 >
      DateTime.toEpochMillis(sealed.expiresAt)
  )
    return new Expired();

  if (
    response.status === "NOT_FOUND" &&
    Option.isSome(sender) &&
    response.latestLedger >= sender.value.ledger &&
    BigInt(sender.value.sequence) >= BigInt(inner.sequence) &&
    response.oldestLedgerCloseTime <= minTime
  )
    return new Rejected({ code: "sequence_consumed" });

  return new Undecided();
}

export class Chain extends Context.Service<
  Chain,
  AssetChain & {
    validAddress(address: AccountAddress): boolean;
    memoRequiredFor(
      address: AccountAddress,
    ): Effect.Effect<Option.Option<KnownExchangeMemo>, ChainUnreachable>;
    pastOpeningWindow(sealed: Sealed): Effect.Effect<boolean, ChainUnreachable>;
    account(
      address: AccountAddress,
    ): Effect.Effect<Option.Option<AccountState>, ChainUnreachable>;
    balance(
      address: AccountAddress,
    ): Effect.Effect<Option.Option<Amount>, ChainUnreachable>;
    draftOpening(
      address: AccountAddress,
    ): Effect.Effect<SigningRequest, ChainUnreachable>;
    draftPayment(
      from: AccountAddress,
      to: AccountAddress,
      asset: Asset,
      amount: PositiveAmount,
      memo?: PaymentMemo,
    ): Effect.Effect<SigningRequest, ChainUnreachable>;
    draftRecovery(
      address: AccountAddress,
    ): Effect.Effect<SigningRequest, ChainUnreachable>;
    seal(
      request: SigningRequest,
      approval: Approval,
      holder: AccountAddress,
    ): Effect.Effect<Sealed, ApprovalInvalid>;
    submit(
      sealed: Sealed,
    ): Effect.Effect<void, ChainUnreachable | SubmissionRejected>;
    settlement(sealed: Sealed): Effect.Effect<Settlement, ChainUnreachable>;
  }
>()("@workspace/wallet/server/Chain") {
  static readonly layer = Layer.effect(
    Chain,
    Effect.gen(function* () {
      const settings = yield* WalletSettings;
      const rpcUrl = yield* validateRpcUrl(settings.rpcUrl);
      const rpcTimeout = yield* validateRpcTimeout(settings.rpcTimeout);
      const rpc = stellarRpc(yield* HttpClient.HttpClient, rpcUrl, rpcTimeout);

      const sponsor = Keypair.fromSecret(
        Redacted.value(settings.reserveSponsorSecret),
      );

      const feePayer = Keypair.fromSecret(
        Redacted.value(settings.feePayerSecret),
      );

      const sponsorAddress = Schema.decodeSync(AccountAddress)(
        sponsor.publicKey(),
      );

      const account = Effect.fn("Chain.account")(function* (
        address: AccountAddress,
      ) {
        const keys = [
          xdr.LedgerKey.account(
            new xdr.LedgerKeyAccount({
              accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
            }),
          ),
          xdr.LedgerKey.trustline(
            new xdr.LedgerKeyTrustLine({
              accountId: Keypair.fromPublicKey(address).xdrAccountId(),
              asset: usdc.toTrustLineXdrObject(),
            }),
          ),
        ];

        const response = yield* rpc.entries(keys);

        return accountFromEntries(
          response.entries ?? [],
          response.latestLedger,
          sponsorAddress,
        );
      });

      const source = Effect.fn("Chain.source")(function* (
        address: AccountAddress,
      ) {
        const state = yield* account(address);

        if (Option.isNone(state))
          return yield* Effect.die(new Error("Account does not exist"));

        return new Account(address, state.value.sequence);
      });

      const request = (envelope: SigningRequest["envelope"], maxTime: number) =>
        new SigningRequest({
          envelope,
          expiresAt: DateTime.makeUnsafe(maxTime * 1000),
        });

      const draftOpen = Effect.fn("Chain.draftOpening")(function* (
        address: AccountAddress,
      ) {
        const sponsorAccount = yield* source(sponsorAddress);
        const current = yield* account(address);
        const now = Math.floor(Date.now() / 1000);

        return request(
          draftOpening({
            source: sponsorAccount,
            address,
            minTime: now,
            maxTime: now + paymentLifetime,
            createAccount: Option.isNone(current),
          }),
          now + paymentLifetime,
        );
      });

      const draftPay = Effect.fn("Chain.draftPayment")(function* (
        from: AccountAddress,
        to: AccountAddress,
        asset: Asset,
        amount: PositiveAmount,
        memo?: PaymentMemo,
      ) {
        const holder = yield* source(from);
        const now = Math.floor(Date.now() / 1000);

        return request(
          draftPayment({
            source: holder,
            to,
            asset,
            amount,
            memo,
            minTime: now,
            maxTime: now + paymentLifetime,
          }),
          now + paymentLifetime,
        );
      });

      const draftRecover = Effect.fn("Chain.draftRecovery")(function* (
        address: AccountAddress,
      ) {
        const holder = yield* source(address);
        const minTime = Math.floor(Date.now() / 1000) + recoveryDelay;
        const maxTime = minTime + recoveryWindow;

        return request(
          draftRecovery({
            source: holder,
            reserveSponsor: sponsorAddress,
            minTime,
            maxTime,
          }),
          maxTime,
        );
      });

      const seal = (
        signingRequest: SigningRequest,
        approval: Approval,
        holder: AccountAddress,
      ) =>
        Effect.try({
          try: () => {
            const facts = readEnvelope(signingRequest.envelope);

            if (Option.isNone(facts)) throw new Error("Invalid layout");

            const permitted = Match.valueTags(facts.value, {
              OpeningFacts: (f) =>
                f.address === holder && f.reserveSponsor === sponsorAddress,
              PaymentFacts: (f) => f.from === holder,
              RecoveryFacts: (f) =>
                f.address === holder && f.reserveSponsor === sponsorAddress,
              TrustlineFacts: (f) =>
                f.address === holder && f.reserveSponsor === sponsorAddress,
              TrustlineRemovalFacts: (f) => f.address === holder,
              ClaimableFacts: (f) =>
                f.from === holder && f.reserveSponsor === sponsorAddress,
              ClaimFacts: (f) =>
                f.address === holder &&
                (!f.reserveSponsor || f.reserveSponsor === sponsorAddress),
            });

            const sponsoring = Match.valueTags(facts.value, {
              OpeningFacts: () => true,
              PaymentFacts: () => false,
              RecoveryFacts: () => false,
              TrustlineFacts: () => true,
              TrustlineRemovalFacts: () => false,
              ClaimableFacts: () => true,
              ClaimFacts: (f) => f.reserveSponsor !== undefined,
            });

            if (
              !permitted ||
              facts.value.maxTime * 1000 !==
                DateTime.toEpochMillis(signingRequest.expiresAt) ||
              DateTime.toEpochMillis(signingRequest.expiresAt) <
                Date.now() + approvalMargin * 1000
            )
              throw new Error("Invalid or stale approval");

            const inner = TransactionBuilder.fromXDR(
              signingRequest.envelope,
              networkPassphrase,
            );

            if (!(inner instanceof Transaction))
              throw new Error("Inner transaction required");

            inner.addSignature(
              holder,
              btoa(String.fromCharCode(...approval.signature)),
            );

            if (sponsoring) inner.sign(sponsor);

            const outer = TransactionBuilder.buildFeeBumpTransaction(
              feePayer.publicKey(),
              baseFee,
              inner,
              networkPassphrase,
            );

            outer.sign(feePayer);

            return new Sealed({
              envelope: outer.toXDR(),
              hash: Array.from(outer.hash(), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
              expiresAt: signingRequest.expiresAt,
            });
          },
          catch: () => new ApprovalInvalid(),
        });

      const submit = (sealed: Sealed) =>
        rpc
          .call(
            "sendTransaction",
            { transaction: sealed.envelope },
            RawSendTransaction,
          )
          .pipe(
            Effect.flatMap((reply) =>
              Match.value(reply).pipe(
                Match.when({ status: "PENDING" }, () => Effect.void),
                Match.when({ status: "DUPLICATE" }, () => Effect.void),
                Match.when({ status: "TRY_AGAIN_LATER" }, () =>
                  Effect.fail(
                    new ChainUnreachable({
                      cause: new Error(
                        "Stellar RPC sendTransaction returned TRY_AGAIN_LATER",
                      ),
                    }),
                  ),
                ),
                Match.when({ status: "ERROR" }, ({ errorResultXdr }) =>
                  Effect.fail(
                    errorResultXdr === undefined
                      ? new SubmissionRejected({})
                      : new SubmissionRejected({
                          code: resultCode(
                            xdr.TransactionResult.fromXDR(
                              errorResultXdr,
                              "base64",
                            ),
                          ),
                        }),
                  ),
                ),
                Match.exhaustive,
              ),
            ),
          );

      const transaction = (hash: string) =>
        rpc
          .call("getTransaction", { hash }, RawTransactionLookup)
          .pipe(Effect.map(transactionLookup));

      const settlement = (sealed: Sealed) =>
        resolveSettlement(sealed, { transaction, account });

      const pastOpeningWindow = (sealed: Sealed) =>
        rpc
          .call(
            "getLatestLedger",
            {},
            Schema.Struct({ closeTime: Schema.NumberFromString }),
          )
          .pipe(
            Effect.map(
              ({ closeTime }) =>
                closeTime * 1000 > DateTime.toEpochMillis(sealed.expiresAt),
            ),
          );

      const assets = assetChain(rpc, sponsorAddress, source);

      return Chain.of({
        ...assets,
        validAddress: StrKey.isValidEd25519PublicKey,
        memoRequiredFor: (address) => memoRequirementFor(rpc, address),
        pastOpeningWindow,
        account,
        balance: (address) =>
          account(address).pipe(
            Effect.map(Option.flatMap((state) => state.balance)),
          ),
        draftOpening: draftOpen,
        draftPayment: draftPay,
        draftRecovery: draftRecover,
        seal,
        submit,
        settlement,
      });
    }),
  );
}

export interface SettlementReader {
  transaction(hash: string): Effect.Effect<TransactionLookup, ChainUnreachable>;
  account(
    address: AccountAddress,
  ): Effect.Effect<Option.Option<AccountState>, ChainUnreachable>;
}

export const resolveSettlement = Effect.fn("Chain.resolveSettlement")(
  function* (sealed: Sealed, reader: SettlementReader) {
    const envelope = TransactionBuilder.fromXDR(
      sealed.envelope,
      networkPassphrase,
    );

    const inner =
      envelope instanceof FeeBumpTransaction
        ? envelope.innerTransaction
        : envelope;

    const innerHash = Array.from(inner.hash(), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    const outerResponse = yield* reader.transaction(sealed.hash);
    const outer = settlementFromResponse(outerResponse, sealed, Option.none());

    if (
      Predicate.isTagged(outer, "Applied") ||
      Predicate.isTagged(outer, "Rejected")
    )
      return outer;

    const innerResponse =
      innerHash === sealed.hash
        ? outerResponse
        : yield* reader.transaction(innerHash);

    const found = settlementFromResponse(innerResponse, sealed, Option.none());

    if (
      Predicate.isTagged(found, "Applied") ||
      Predicate.isTagged(found, "Rejected")
    )
      return found;

    const sender = yield* reader.account(
      Schema.decodeSync(AccountAddress)(inner.source),
    );

    const confirmed = yield* reader.transaction(innerHash);

    return settlementFromResponse(confirmed, sealed, sender);
  },
);
