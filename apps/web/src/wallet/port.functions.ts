import { type CustomFetch, createServerFn } from "@tanstack/react-start";
import {
  AccountAddress,
  AssetOrder,
  AssetStep,
  Approval,
  BackupEnrollment,
  ChallengePurpose,
  EnrollStep,
  PasskeyAssertion,
  PasskeyChallenge,
  RestoreStep,
  OpenStep,
  Overview,
  TransferOrder,
  TransferStep,
  InvalidResponse,
  Offline,
  ServerFailure,
  WalletClaim,
  type WalletPort,
} from "@workspace/wallet";
import { Wallet } from "@workspace/wallet/server";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { answerWallet } from "../server/wallet.server";

const OverviewCall = Schema.Struct({ address: AccountAddress });

const OpenCall = Schema.Struct({
  claim: WalletClaim,
  approval: Schema.OptionFromNullOr(Approval),
});

const TransferCall = Schema.Struct({
  order: TransferOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const ManageCall = Schema.Struct({
  order: AssetOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const ChallengeCall = Schema.Struct({ purpose: ChallengePurpose });

const EnrollCall = Schema.Struct({ enrollment: BackupEnrollment });

const RestoreCall = Schema.Struct({ assertion: PasskeyAssertion });

const overviewFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(OverviewCall))
  .handler(({ data }) =>
    answerWallet(
      Overview,
      Wallet.use((wallet) => wallet.overview(data.address)),
    ),
  );

const openFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(OpenCall))
  .handler(({ data }) =>
    answerWallet(
      OpenStep,
      Wallet.use((wallet) => wallet.open(data.claim, data.approval)),
    ),
  );

const transferFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TransferCall))
  .handler(({ data }) =>
    answerWallet(
      TransferStep,
      Wallet.use((wallet) => wallet.transfer(data.order, data.approval)),
    ),
  );

const manageFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(ManageCall))
  .handler(({ data }) =>
    answerWallet(
      AssetStep,
      Wallet.use((wallet) => wallet.manage(data.order, data.approval)),
    ),
  );

const passkeyChallengeFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(ChallengeCall))
  .handler(({ data }) =>
    answerWallet(
      PasskeyChallenge,
      Wallet.use((wallet) => wallet.passkeyChallenge(data.purpose)),
    ),
  );

const enrollFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(EnrollCall))
  .handler(({ data }) =>
    answerWallet(
      EnrollStep,
      Wallet.use((wallet) => wallet.enroll(data.enrollment)),
    ),
  );

const restoreFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(RestoreCall))
  .handler(({ data }) =>
    answerWallet(
      RestoreStep,
      Wallet.use((wallet) => wallet.restore(data.assertion)),
    ),
  );

const reachingFetch: CustomFetch = (input, init) =>
  fetch(input, init).catch(() => Promise.reject(new Offline()));

const isServerFailure = Schema.is(ServerFailure);

const reach = <A, I, C, D, R>(
  step: Schema.Codec<A, I>,
  call: Schema.Codec<C, D>,
  request: C,
  serverFn: (options: { data: D; fetch: CustomFetch }) => Promise<R>,
) =>
  Schema.encodeEffect(call)(request).pipe(
    Effect.orDie,
    Effect.flatMap((data) =>
      Effect.tryPromise({
        try: () => serverFn({ data, fetch: reachingFetch }),
        catch: (cause) =>
          Predicate.isTagged(cause, "Offline")
            ? new Offline()
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
  overview: (address) => reach(Overview, OverviewCall, { address }, overviewFn),
  open: (claim, approval) =>
    reach(OpenStep, OpenCall, { claim, approval }, openFn),
  transfer: (order, approval) =>
    reach(TransferStep, TransferCall, { order, approval }, transferFn),
};
