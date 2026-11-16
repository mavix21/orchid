import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AccountAddress, Approval, PositiveUsdc, SigningRequest, Usdc } from "../contract";
import { draftOpening, draftPayment, draftRecovery, readEnvelope } from "../stellar/envelopes";
import {
  approvalMargin,
  baseFee,
  networkPassphrase,
  paymentLifetime,
  recoveryDelay,
  recoveryWindow,
  usdc,
} from "../stellar/network";
import { WalletSettings } from "./settings.server";

export class Sealed extends Schema.Class<Sealed>("Sealed")({
  envelope: Schema.String,
  hash: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

export class Applied extends Schema.TaggedClass<Applied>()("Applied", {
  at: Schema.DateTimeUtcFromString,
}) {}

export class Rejected extends Schema.TaggedClass<Rejected>()("Rejected", { code: Schema.String }) {}

export class Expired extends Schema.TaggedClass<Expired>()("Expired", {}) {}

export class Undecided extends Schema.TaggedClass<Undecided>()("Undecided", {}) {}

export type Settlement = Applied | Rejected | Expired | Undecided;

export class ChainUnreachable extends Schema.TaggedError<ChainUnreachable>()("ChainUnreachable", {
  cause: Schema.Defect(),
}) {}

export class ApprovalInvalid extends Schema.TaggedError<ApprovalInvalid>()("ApprovalInvalid", {}) {}

export interface AccountState {
  readonly sequence: string;
  readonly nativeBalance: bigint;
  readonly balance: Option.Option<Usdc>;
}

export function settlementFromResponse(
  response: rpc.Api.GetTransactionResponse,
  sealed: Sealed,
): Settlement {
  if (response.status === rpc.Api.GetTransactionStatus.SUCCESS)
    return new Applied({ at: DateTime.makeUnsafe(response.createdAt * 1000) });

  if (response.status === rpc.Api.GetTransactionStatus.FAILED)
    return new Rejected({ code: response.resultXdr.result.type });

  const envelope = TransactionBuilder.fromXDR(sealed.envelope, networkPassphrase);
  const inner = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  const minTime = Number(inner.timeBounds?.minTime);

  // RPC absence is proof only when its history covers the entire inclusion window.
  if (
    response.oldestLedgerCloseTime <= minTime &&
    response.latestLedgerCloseTime * 1000 > DateTime.toEpochMillis(sealed.expiresAt)
  )
    return new Expired();

  return new Undecided();
}

export class Chain extends Context.Service<
  Chain,
  {
    account(address: AccountAddress): Effect.Effect<Option.Option<AccountState>, ChainUnreachable>;
    balance(address: AccountAddress): Effect.Effect<Option.Option<Usdc>, ChainUnreachable>;
    draftOpening(address: AccountAddress): Effect.Effect<SigningRequest, ChainUnreachable>;
    draftPayment(
      from: AccountAddress,
      to: AccountAddress,
      amount: PositiveUsdc,
    ): Effect.Effect<SigningRequest, ChainUnreachable>;
    draftRecovery(address: AccountAddress): Effect.Effect<SigningRequest, ChainUnreachable>;
    seal(
      request: SigningRequest,
      approval: Approval,
      holder: AccountAddress,
    ): Effect.Effect<Sealed, ApprovalInvalid>;
    submit(sealed: Sealed): Effect.Effect<void, ChainUnreachable>;
    settlement(sealed: Sealed): Effect.Effect<Settlement, ChainUnreachable>;
  }
>()("@workspace/wallet/server/Chain") {
  static readonly layer = Layer.effect(
    Chain,
    Effect.gen(function* () {
      const settings = yield* WalletSettings;
      const server = new rpc.Server(settings.rpcUrl);
      const sponsor = Keypair.fromSecret(Redacted.value(settings.reserveSponsorSecret));
      const feePayer = Keypair.fromSecret(Redacted.value(settings.feePayerSecret));
      const sponsorAddress = Schema.decodeSync(AccountAddress)(sponsor.publicKey());

      const account = Effect.fn("Chain.account")(function* (address: AccountAddress) {
        const response = yield* Effect.tryPromise({
          try: () =>
            server.getLedgerEntries(
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
            ),
          catch: (cause) => new ChainUnreachable({ cause }),
        });

        const entry = response.entries.find((item) => item.val.type === "account")?.val;
        const trust = response.entries.find((item) => item.val.type === "trustline")?.val;

        if (!entry || entry.type !== "account") return Option.none<AccountState>();

        return Option.some<AccountState>({
          sequence: entry.value.seqNum.toString(),
          nativeBalance: entry.value.balance,
          balance:
            trust?.type === "trustline"
              ? Option.some(Schema.decodeSync(Usdc)(trust.value.balance.toString()))
              : Option.none(),
        });
      });

      const source = Effect.fn("Chain.source")(function* (address: AccountAddress) {
        const state = yield* account(address);

        if (Option.isNone(state))
          return yield* new ChainUnreachable({ cause: new Error("Account does not exist") });

        return new Account(address, state.value.sequence);
      });

      const request = (envelope: SigningRequest["envelope"], maxTime: number) =>
        new SigningRequest({ envelope, expiresAt: DateTime.makeUnsafe(maxTime * 1000) });

      const draftOpen = Effect.fn("Chain.draftOpening")(function* (address: AccountAddress) {
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
        amount: PositiveUsdc,
      ) {
        const holder = yield* source(from);
        const now = Math.floor(Date.now() / 1000);

        return request(
          draftPayment({
            source: holder,
            to,
            amount,
            minTime: now,
            maxTime: now + paymentLifetime,
          }),
          now + paymentLifetime,
        );
      });

      const draftRecover = Effect.fn("Chain.draftRecovery")(function* (address: AccountAddress) {
        const holder = yield* source(address);
        const minTime = Math.floor(Date.now() / 1000) + recoveryDelay;
        const maxTime = minTime + recoveryWindow;

        return request(
          draftRecovery({ source: holder, reserveSponsor: sponsorAddress, minTime, maxTime }),
          maxTime,
        );
      });

      const seal = (signingRequest: SigningRequest, approval: Approval, holder: AccountAddress) =>
        Effect.try({
          try: () => {
            const facts = readEnvelope(signingRequest.envelope);

            if (Option.isNone(facts)) throw new Error("Invalid layout");

            const permitted = Match.valueTags(facts.value, {
              OpeningFacts: (f) => f.address === holder && f.reserveSponsor === sponsorAddress,
              PaymentFacts: (f) => f.from === holder,
              RecoveryFacts: (f) => f.address === holder && f.reserveSponsor === sponsorAddress,
            });

            if (
              !permitted ||
              facts.value.maxTime * 1000 !== DateTime.toEpochMillis(signingRequest.expiresAt) ||
              DateTime.toEpochMillis(signingRequest.expiresAt) < Date.now() + approvalMargin * 1000
            )
              throw new Error("Invalid or stale approval");

            const inner = TransactionBuilder.fromXDR(signingRequest.envelope, networkPassphrase);

            if (!(inner instanceof Transaction)) throw new Error("Inner transaction required");

            inner.addSignature(holder, btoa(String.fromCharCode(...approval.signature)));
            Match.valueTags(facts.value, {
              OpeningFacts: () => inner.sign(sponsor),
              PaymentFacts: () => {},
              RecoveryFacts: () => {},
            });

            const outer = TransactionBuilder.buildFeeBumpTransaction(
              feePayer.publicKey(),
              baseFee,
              inner,
              networkPassphrase,
            );

            outer.sign(feePayer);

            return new Sealed({
              envelope: outer.toXDR(),
              hash: Array.from(outer.hash(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
              expiresAt: signingRequest.expiresAt,
            });
          },
          catch: () => new ApprovalInvalid(),
        });

      const submit = (sealed: Sealed) =>
        Effect.tryPromise({
          try: async () => {
            await server.sendTransaction(
              TransactionBuilder.fromXDR(sealed.envelope, networkPassphrase),
            );
          },
          catch: (cause) => new ChainUnreachable({ cause }),
        });

      const settlement = (sealed: Sealed) =>
        Effect.tryPromise({
          try: async () => settlementFromResponse(await server.getTransaction(sealed.hash), sealed),
          catch: (cause) => new ChainUnreachable({ cause }),
        });

      return Chain.of({
        account,
        balance: (address) =>
          account(address).pipe(Effect.map(Option.flatMap((state) => state.balance))),
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
