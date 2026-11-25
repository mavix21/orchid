import { type CustomFetch, createServerFn } from "@tanstack/react-start";
import {
  AccountAddress,
  ActivityCursor,
  ActivityStep,
  AssetOrder,
  AssetStep,
  Approval,
  Approvals,
  BackupEnrollment,
  EnrollStep,
  EnrollmentChallengeStep,
  ExternalLinkOrder,
  ExternalLinkStep,
  HumanCheckToken,
  PasskeyAssertion,
  PasskeyChallenge,
  RestoreStep,
  SessionStep,
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
import { Principal, Wallet } from "@workspace/wallet/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { answerWallet } from "../server/wallet.server";
import { takeHumanCheck } from "./human-check";

const OverviewCall = Schema.Struct({ address: AccountAddress });

const OpenCall = Schema.Struct({
  claim: WalletClaim,
  approvals: Schema.OptionFromNullOr(Approvals),
  humanCheck: Schema.OptionFromNullOr(HumanCheckToken),
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

const ActivityCall = Schema.Struct({
  address: AccountAddress,
  before: Schema.optional(ActivityCursor),
});

const PaymentLinkCall = Schema.Struct({ link: AccountAddress });

const ClaimPaymentLinkCall = Schema.Struct({
  order: ExternalLinkOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const ResolvePaymentLinkCall = Schema.Struct({
  sender: AccountAddress,
  receipt: PaymentLinkReceipt,
});

const RestoreChallengeCall = Schema.Struct({});

const EnrollmentChallengeCall = Schema.Struct({
  claim: WalletClaim,
  humanCheck: Schema.OptionFromNullOr(HumanCheckToken),
});

const EnrollCall = Schema.Struct({
  enrollment: BackupEnrollment,
  approvals: Schema.OptionFromNullOr(Approvals),
});

const RestoreCall = Schema.Struct({ assertion: PasskeyAssertion });

const SessionChallengeCall = Schema.Struct({});

const BeginSessionCall = Schema.Struct({ assertion: PasskeyAssertion });

const accepted =
  <D>() =>
  (data: D) =>
    data;

const speakingFor = <A, E, R>(
  address: AccountAddress,
  program: Effect.Effect<A, E, R>,
) =>
  Principal.use((principal) => principal.speaksFor(address)).pipe(
    Effect.andThen(program),
  );

const publicly = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Principal.use((principal) => principal.admitsPublicCall).pipe(
    Effect.andThen(program),
  );

const overviewFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof OverviewCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(OverviewCall, data, Overview, (decoded) =>
      speakingFor(
        decoded.address,
        Wallet.use((wallet) => wallet.overview(decoded.address)),
      ),
    ),
  );

const openFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof OpenCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(OpenCall, data, OpenStep, (decoded) =>
      publicly(
        Wallet.use((wallet) =>
          wallet.open(decoded.claim, decoded.approvals, decoded.humanCheck),
        ),
      ),
    ),
  );

const transferFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof TransferCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(TransferCall, data, TransferStep, (decoded) =>
      speakingFor(
        decoded.order.from,
        Wallet.use((wallet) =>
          wallet.transfer(decoded.order, decoded.approval),
        ),
      ),
    ),
  );

const manageFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ManageCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(ManageCall, data, AssetStep, (decoded) =>
      Principal.use((principal) =>
        principal.admitsDrafting(decoded.order, decoded.approval),
      ).pipe(
        Effect.andThen(
          Wallet.use((wallet) =>
            wallet.manage(decoded.order, decoded.approval),
          ),
        ),
      ),
    ),
  );

const paymentLinksFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof PaymentLinksCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(PaymentLinksCall, data, PaymentLinksStep, (decoded) =>
      speakingFor(
        decoded.address,
        Wallet.use((wallet) => wallet.paymentLinks(decoded.address)),
      ),
    ),
  );

const activityFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ActivityCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(ActivityCall, data, ActivityStep, (decoded) =>
      speakingFor(
        decoded.address,
        Wallet.use((wallet) =>
          wallet.activity(decoded.address, decoded.before),
        ),
      ),
    ),
  );

const paymentLinkFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof PaymentLinkCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(PaymentLinkCall, data, PaymentLinkStep, (decoded) =>
      publicly(Wallet.use((wallet) => wallet.paymentLink(decoded.link))),
    ),
  );

const claimPaymentLinkFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ClaimPaymentLinkCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(ClaimPaymentLinkCall, data, ExternalLinkStep, (decoded) =>
      publicly(
        Wallet.use((wallet) =>
          wallet.claimPaymentLink(decoded.order, decoded.approval),
        ),
      ),
    ),
  );

const resolvePaymentLinkFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ResolvePaymentLinkCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(ResolvePaymentLinkCall, data, ResolveReceiptStep, (decoded) =>
      speakingFor(
        decoded.sender,
        Wallet.use((wallet) =>
          wallet.resolvePaymentLink(decoded.sender, decoded.receipt),
        ),
      ),
    ),
  );

const restoreChallengeFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof RestoreChallengeCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(RestoreChallengeCall, data, PasskeyChallenge, () =>
      publicly(Wallet.use((wallet) => wallet.restoreChallenge())),
    ),
  );

const enrollmentChallengeFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof EnrollmentChallengeCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(
      EnrollmentChallengeCall,
      data,
      EnrollmentChallengeStep,
      (decoded) =>
        publicly(
          Wallet.use((wallet) =>
            wallet.enrollmentChallenge(decoded.claim, decoded.humanCheck),
          ),
        ),
    ),
  );

const enrollFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof EnrollCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(EnrollCall, data, EnrollStep, (decoded) =>
      publicly(
        Wallet.use((wallet) =>
          wallet.enroll(decoded.enrollment, decoded.approvals),
        ),
      ),
    ),
  );

const restoreFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof RestoreCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(RestoreCall, data, RestoreStep, (decoded) =>
      publicly(Wallet.use((wallet) => wallet.restore(decoded.assertion))),
    ),
  );

const sessionChallengeFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof SessionChallengeCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(SessionChallengeCall, data, PasskeyChallenge, () =>
      publicly(Wallet.use((wallet) => wallet.sessionChallenge())),
    ),
  );

const beginSessionFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof BeginSessionCall.Encoded>())
  .handler(({ data }) =>
    answerWallet(BeginSessionCall, data, SessionStep, (decoded) =>
      publicly(Wallet.use((wallet) => wallet.beginSession(decoded.assertion))),
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
  restoreChallenge: () =>
    reach(PasskeyChallenge, RestoreChallengeCall, {}, restoreChallengeFn),
  enrollmentChallenge: (claim) =>
    Effect.promise(takeHumanCheck).pipe(
      Effect.flatMap((humanCheck) =>
        reach(
          EnrollmentChallengeStep,
          EnrollmentChallengeCall,
          { claim, humanCheck },
          enrollmentChallengeFn,
        ),
      ),
    ),
  enroll: (enrollment, approvals) =>
    reach(EnrollStep, EnrollCall, { enrollment, approvals }, enrollFn),
  restore: (assertion) =>
    reach(RestoreStep, RestoreCall, { assertion }, restoreFn),
  sessionChallenge: () =>
    reach(PasskeyChallenge, SessionChallengeCall, {}, sessionChallengeFn),
  beginSession: (assertion) =>
    reach(SessionStep, BeginSessionCall, { assertion }, beginSessionFn),
  manage: (order, approval) =>
    reach(AssetStep, ManageCall, { order, approval }, manageFn),
  paymentLinks: (address) =>
    reach(PaymentLinksStep, PaymentLinksCall, { address }, paymentLinksFn),
  activity: (address, before) =>
    reach(ActivityStep, ActivityCall, { address, before }, activityFn),
  paymentLink: (link) =>
    reach(PaymentLinkStep, PaymentLinkCall, { link }, paymentLinkFn),
  claimPaymentLink: (order, approval) =>
    reach(
      ExternalLinkStep,
      ClaimPaymentLinkCall,
      { order, approval },
      claimPaymentLinkFn,
    ),
  resolvePaymentLink: (sender, receipt) =>
    reach(
      ResolveReceiptStep,
      ResolvePaymentLinkCall,
      { sender, receipt },
      resolvePaymentLinkFn,
    ),
  overview: (address) => reach(Overview, OverviewCall, { address }, overviewFn),
  open: (claim, approvals) =>
    Effect.promise(() =>
      Option.isSome(approvals)
        ? takeHumanCheck()
        : Promise.resolve(Option.none<HumanCheckToken>()),
    ).pipe(
      Effect.flatMap((humanCheck) =>
        reach(OpenStep, OpenCall, { claim, approvals, humanCheck }, openFn),
      ),
    ),
  transfer: (order, approval) =>
    reach(TransferStep, TransferCall, { order, approval }, transferFn),
};
