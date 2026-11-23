import { type CustomFetch, createServerFn } from "@tanstack/react-start";
import {
  AccountAddress,
  AssetOrder,
  AssetStep,
  Approval,
  Approvals,
  BackupEnrollment,
  ChallengePurpose,
  EnrollStep,
  PasskeyAssertion,
  PasskeyChallenge,
  RestoreStep,
  OpenStep,
  Overview,
  PaymentLinkReceipt,
  PaymentLinkStep,
  PaymentLinksStep,
  ResolveReceiptStep,
  TransferOrder,
  TransferStep,
  InvalidResponse,
  Offline,
  ServerFailure,
  ServerUnreachable,
  WalletClaim,
  type WalletPort,
  unreachedServer,
} from "@workspace/wallet";
import { Wallet } from "@workspace/wallet/server";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { answerWallet } from "../server/wallet.server";

const OverviewCall = Schema.Struct({ address: AccountAddress });

const OpenCall = Schema.Struct({
  claim: WalletClaim,
  approvals: Schema.OptionFromNullOr(Approvals),
});

const TransferCall = Schema.Struct({
  order: TransferOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const ManageCall = Schema.Struct({
  order: AssetOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const PaymentLinksCall = Schema.Struct({ address: AccountAddress });

const PaymentLinkCall = Schema.Struct({ link: AccountAddress });

const ResolvePaymentLinkCall = Schema.Struct({
  sender: AccountAddress,
  receipt: PaymentLinkReceipt,
});

const ChallengeCall = Schema.Struct({ purpose: ChallengePurpose });

const EnrollCall = Schema.Struct({ enrollment: BackupEnrollment });

const RestoreCall = Schema.Struct({ assertion: PasskeyAssertion });

const accepted =
  <D>() =>
  (data: D) =>
    data;

const overviewFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof OverviewCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(OverviewCall, data, Overview, (decoded) =>
      Wallet.use((wallet) => wallet.overview(decoded.address)),
    ),
  );

const openFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof OpenCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(OpenCall, data, OpenStep, (decoded) =>
      Wallet.use((wallet) => wallet.open(decoded.claim, decoded.approvals)),
    ),
  );

const transferFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof TransferCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(TransferCall, data, TransferStep, (decoded) =>
      Wallet.use((wallet) => wallet.transfer(decoded.order, decoded.approval)),
    ),
  );

const manageFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ManageCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(ManageCall, data, AssetStep, (decoded) =>
      Wallet.use((wallet) => wallet.manage(decoded.order, decoded.approval)),
    ),
  );

const paymentLinksFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof PaymentLinksCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(PaymentLinksCall, data, PaymentLinksStep, (decoded) =>
      Wallet.use((wallet) => wallet.paymentLinks(decoded.address)),
    ),
  );

const paymentLinkFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof PaymentLinkCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(PaymentLinkCall, data, PaymentLinkStep, (decoded) =>
      Wallet.use((wallet) => wallet.paymentLink(decoded.link)),
    ),
  );

const resolvePaymentLinkFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ResolvePaymentLinkCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(ResolvePaymentLinkCall, data, ResolveReceiptStep, (decoded) =>
      Wallet.use((wallet) =>
        wallet.resolvePaymentLink(decoded.sender, decoded.receipt),
      ),
    ),
  );

const passkeyChallengeFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ChallengeCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(ChallengeCall, data, PasskeyChallenge, (decoded) =>
      Wallet.use((wallet) => wallet.passkeyChallenge(decoded.purpose)),
    ),
  );

const enrollFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof EnrollCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(EnrollCall, data, EnrollStep, (decoded) =>
      Wallet.use((wallet) => wallet.enroll(decoded.enrollment)),
    ),
  );

const restoreFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof RestoreCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(RestoreCall, data, RestoreStep, (decoded) =>
      Wallet.use((wallet) => wallet.restore(decoded.assertion)),
    ),
  );

const reachingFetch: CustomFetch = (input, init) =>
  fetch(input, init).catch(() => Promise.reject(unreachedServer()));

const isServerFailure = Schema.is(ServerFailure);

const reach = <A, I, C, D, R>(
  step: Schema.Codec<A, I>,
  call: Schema.Codec<C, D>,
  request: C,
  serverFn: (options: {
    data: D;
    fetch: CustomFetch;
    signal: AbortSignal;
  }) => Promise<R>,
) =>
  Schema.encodeEffect(call)(request).pipe(
    Effect.orDie,
    Effect.flatMap((data) =>
      Effect.tryPromise({
        try: (signal) => serverFn({ data, fetch: reachingFetch, signal }),
        catch: (cause) =>
          Predicate.isTagged(cause, "Offline")
            ? new Offline()
            : Predicate.isTagged(cause, "ServerUnreachable")
              ? new ServerUnreachable()
              : new InvalidResponse(),
      }),
    ),
    Effect.flatMap((answer) =>
      Schema.decodeUnknownEffect(Schema.Union([step, ServerFailure]))(
        answer,
      ).pipe(Effect.mapError(() => new InvalidResponse())),
    ),
    Effect.flatMap((answer) =>
      isServerFailure(answer) ? Effect.fail(answer) : Effect.succeed(answer),
    ),
  );

export const port: WalletPort = {
  passkeyChallenge: (purpose) =>
    reach(PasskeyChallenge, ChallengeCall, { purpose }, passkeyChallengeFn),
  enroll: (enrollment) =>
    reach(EnrollStep, EnrollCall, { enrollment }, enrollFn),
  restore: (assertion) =>
    reach(RestoreStep, RestoreCall, { assertion }, restoreFn),
  manage: (order, approval) =>
    reach(AssetStep, ManageCall, { order, approval }, manageFn),
  paymentLinks: (address) =>
    reach(PaymentLinksStep, PaymentLinksCall, { address }, paymentLinksFn),
  paymentLink: (link) =>
    reach(PaymentLinkStep, PaymentLinkCall, { link }, paymentLinkFn),
  resolvePaymentLink: (sender, receipt) =>
    reach(
      ResolveReceiptStep,
      ResolvePaymentLinkCall,
      { sender, receipt },
      resolvePaymentLinkFn,
    ),
  overview: (address) => reach(Overview, OverviewCall, { address }, overviewFn),
  open: (claim, approvals) =>
    reach(OpenStep, OpenCall, { claim, approvals }, openFn),
  transfer: (order, approval) =>
    reach(TransferStep, TransferCall, { order, approval }, transferFn),
};
