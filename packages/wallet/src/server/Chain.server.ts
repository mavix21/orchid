import {
  Account,
  Keypair,
  Transaction,
  TransactionBuilder,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
  DestinationAddress,
  Approval,
  type Asset,
  type BalanceId,
  OpeningDraft,
  PaymentMemo,
  PositiveAmount,
  SigningRequest,
  Amount,
} from "../contract";
import { baseAccountOf, isMuxed } from "../stellar/destination";
import { draftOpening, draftPayment, readEnvelope } from "../stellar/envelopes";
import {
  approvalMargin,
  baseFee,
  networkPassphrase,
  paymentLifetime,
  usdc,
} from "../stellar/network";
import { type AssetChain, assetChain } from "./chain-assets.server";
import { type LinkChain, linkChain } from "./chain-links.server";
import { type DepositChain, depositChain } from "./chain-deposits.server";
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
import { validateRpcTimeout, validateRpcUrl } from "./rpc-settings.server";
import { WalletSettings, rpcReadConcurrency } from "./settings.server";

import {
  RawTransactionLookup,
  Sealed,
  type Settlement,
  resolveSettlement,
  resultCode,
  transactionLookup,
} from "./chain-settlement.server";

export {
  Applied,
  Expired,
  Rejected,
  Sealed,
  Undecided,
  resolveSettlement,
  settlementFromResponse,
} from "./chain-settlement.server";

export type {
  Settlement,
  SettlementReader,
  TransactionLookup,
} from "./chain-settlement.server";

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

const RawSendTransaction = Schema.Union([
  Schema.Struct({ status: Schema.Literal("PENDING") }),
  Schema.Struct({ status: Schema.Literal("DUPLICATE") }),
  Schema.Struct({ status: Schema.Literal("TRY_AGAIN_LATER") }),
  Schema.Struct({
    status: Schema.Literal("ERROR"),
    errorResultXdr: Schema.optional(Schema.String),
  }),
]);

export class Chain extends Context.Service<
  Chain,
  AssetChain &
    LinkChain &
    DepositChain & {
      validAddress(address: DestinationAddress): boolean;
      memoRequiredFor(
        address: AccountAddress,
      ): Effect.Effect<Option.Option<KnownExchangeMemo>, ChainUnreachable>;
      pastOpeningWindow(
        sealed: Sealed,
      ): Effect.Effect<boolean, ChainUnreachable>;
      account(
        address: AccountAddress,
      ): Effect.Effect<Option.Option<AccountState>, ChainUnreachable>;
      balance(
        address: AccountAddress,
      ): Effect.Effect<Option.Option<Amount>, ChainUnreachable>;
      draftOpening(
        address: AccountAddress,
        claim?: BalanceId,
      ): Effect.Effect<OpeningDraft, ChainUnreachable>;
      draftPayment(
        from: AccountAddress,
        to: DestinationAddress,
        asset: Asset,
        amount: PositiveAmount,
        memo?: PaymentMemo,
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

      const channel = Schema.decodeSync(AccountAddress)(feePayer.publicKey());

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
        claim?: BalanceId,
      ) {
        const [sponsorState, current] = yield* Effect.all(
          [account(sponsorAddress), account(address)],
          { concurrency: rpcReadConcurrency },
        );

        if (Option.isNone(sponsorState))
          return yield* Effect.die(new Error("Account does not exist"));

        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

        return new OpeningDraft({
          request: request(
            draftOpening({
              source: new Account(sponsorAddress, sponsorState.value.sequence),
              address,
              minTime: now,
              maxTime: now + paymentLifetime,
              createAccount: Option.isNone(current),
              claim,
            }),
            now + paymentLifetime,
          ),
        });
      });

      const draftPay = Effect.fn("Chain.draftPayment")(function* (
        from: AccountAddress,
        to: DestinationAddress,
        asset: Asset,
        amount: PositiveAmount,
        memo?: PaymentMemo,
      ) {
        const holder = yield* source(from);
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

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

      const seal = (
        signingRequest: SigningRequest,
        approval: Approval,
        holder: AccountAddress,
      ) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.try({
              try: () => {
                const facts = readEnvelope(signingRequest.envelope);

                if (Option.isNone(facts)) throw new Error("Invalid layout");

                const permitted = Match.valueTags(facts.value, {
                  OpeningFacts: (f) =>
                    f.address === holder && f.reserveSponsor === sponsorAddress,
                  PaymentFacts: (f) => f.from === holder,
                  TrustlineFacts: (f) =>
                    f.address === holder && f.reserveSponsor === sponsorAddress,
                  TrustlineRemovalFacts: (f) => f.address === holder,
                  ClaimableFacts: (f) =>
                    f.from === holder && f.reserveSponsor === sponsorAddress,
                  PaymentLinkFacts: (f) =>
                    f.from === holder &&
                    f.to !== holder &&
                    f.reserveSponsor === sponsorAddress,
                  ClaimFacts: (f) =>
                    f.address === holder &&
                    (!f.reserveSponsor || f.reserveSponsor === sponsorAddress),
                  LinkReceiveFacts: (f) =>
                    f.link === holder &&
                    baseAccountOf(f.destination) !== holder &&
                    (!isMuxed(f.destination) || f.memo === undefined) &&
                    f.channel === channel &&
                    f.reserveSponsor === sponsorAddress,
                });

                const sponsoring = Match.valueTags(facts.value, {
                  OpeningFacts: () => true,
                  PaymentFacts: () => false,
                  TrustlineFacts: () => true,
                  TrustlineRemovalFacts: () => false,
                  ClaimableFacts: () => true,
                  PaymentLinkFacts: () => true,
                  ClaimFacts: (f) => f.reserveSponsor !== undefined,
                  LinkReceiveFacts: () => true,
                });

                if (
                  !permitted ||
                  facts.value.maxTime * 1000 !==
                    DateTime.toEpochMillis(signingRequest.expiresAt) ||
                  DateTime.toEpochMillis(signingRequest.expiresAt) <
                    now + approvalMargin * 1000
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

                if (
                  Predicate.isTagged(facts.value, "LinkReceiveFacts") &&
                  feePayer.publicKey() !== sponsor.publicKey()
                )
                  inner.sign(feePayer);

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
            }),
          ),
        );

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

      const links = linkChain(sponsor, feePayer, account, source, (envelope) =>
        rpc
          .call(
            "sendTransaction",
            { transaction: envelope },
            RawSendTransaction,
          )
          .pipe(Effect.ignore),
      );

      return Chain.of({
        ...assets,
        ...depositChain(rpc),
        validAddress: (address) =>
          StrKey.isValidEd25519PublicKey(address) ||
          StrKey.isValidMed25519PublicKey(address),
        memoRequiredFor: (address) => memoRequirementFor(rpc, address),
        pastOpeningWindow,
        account,
        balance: (address) =>
          account(address).pipe(
            Effect.map(Option.flatMap((state) => state.balance)),
          ),
        draftOpening: draftOpen,
        draftPayment: draftPay,
        ...links,
        seal,
        submit,
        settlement,
      });
    }),
  );
}
