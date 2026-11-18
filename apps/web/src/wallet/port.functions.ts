import { createServerFn } from "@tanstack/react-start";
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
  WalletClaim,
  WalletUnavailable,
  type WalletPort,
} from "@workspace/wallet";
import { Wallet } from "@workspace/wallet/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runWallet } from "../server/wallet.server";

const OverviewCall = Schema.Struct({ address: AccountAddress });

const OpenCall = Schema.Struct({
  claim: WalletClaim,
  approval: Schema.OptionFromNullOr(Approval),
});

const TransferCall = Schema.Struct({
  order: TransferOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const overviewFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(OverviewCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.overview(data.address)).pipe(
        Effect.flatMap((value) =>
          Schema.encodeEffect(Overview)(value).pipe(Effect.orDie),
        ),
      ),
    ),
  );

const openFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(OpenCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.open(data.claim, data.approval)).pipe(
        Effect.flatMap((value) =>
          Schema.encodeEffect(OpenStep)(value).pipe(Effect.orDie),
        ),
      ),
    ),
  );

const transferFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TransferCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.transfer(data.order, data.approval)).pipe(
        Effect.flatMap((value) =>
          Schema.encodeEffect(TransferStep)(value).pipe(Effect.orDie),
        ),
      ),
    ),
  );

const ManageCall = Schema.Struct({
  order: AssetOrder,
  approval: Schema.OptionFromNullOr(Approval),
});

const manageFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(ManageCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.manage(data.order, data.approval)).pipe(
        Effect.flatMap((value) =>
          Schema.encodeEffect(AssetStep)(value).pipe(Effect.orDie),
        ),
      ),
    ),
  );

const ChallengeCall = Schema.Struct({ purpose: ChallengePurpose });

const EnrollCall = Schema.Struct({ enrollment: BackupEnrollment });

const RestoreCall = Schema.Struct({ assertion: PasskeyAssertion });

const passkeyChallengeFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(ChallengeCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.passkeyChallenge(data.purpose)).pipe(
        Effect.flatMap((value) =>
          Schema.encodeEffect(PasskeyChallenge)(value).pipe(Effect.orDie),
        ),
      ),
    ),
  );

const enrollFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(EnrollCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.enroll(data.enrollment)).pipe(
        Effect.flatMap((value) =>
          Schema.encodeEffect(EnrollStep)(value).pipe(Effect.orDie),
        ),
      ),
    ),
  );

const restoreFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(RestoreCall))
  .handler(({ data }) =>
    runWallet(
      Wallet.use((wallet) => wallet.restore(data.assertion)).pipe(
        Effect.flatMap((value) =>
          Schema.encodeEffect(RestoreStep)(value).pipe(Effect.orDie),
        ),
      ),
    ),
  );

export const port: WalletPort = {
  passkeyChallenge: (purpose) =>
    Schema.encodeEffect(ChallengeCall)({ purpose }).pipe(
      Effect.flatMap((data) =>
        Effect.tryPromise(() => passkeyChallengeFn({ data })),
      ),
      Effect.flatMap(Schema.decodeEffect(PasskeyChallenge)),
      Effect.mapError((cause) => new WalletUnavailable({ cause })),
    ),
  enroll: (enrollment) =>
    Schema.encodeEffect(EnrollCall)({ enrollment }).pipe(
      Effect.flatMap((data) => Effect.tryPromise(() => enrollFn({ data }))),
      Effect.flatMap(Schema.decodeEffect(EnrollStep)),
      Effect.mapError((cause) => new WalletUnavailable({ cause })),
    ),
  restore: (assertion) =>
    Schema.encodeEffect(RestoreCall)({ assertion }).pipe(
      Effect.flatMap((data) => Effect.tryPromise(() => restoreFn({ data }))),
      Effect.flatMap(Schema.decodeEffect(RestoreStep)),
      Effect.mapError((cause) => new WalletUnavailable({ cause })),
    ),
  manage: (order, approval) =>
    Schema.encodeEffect(ManageCall)({ order, approval }).pipe(
      Effect.flatMap((data) => Effect.tryPromise(() => manageFn({ data }))),
      Effect.flatMap(Schema.decodeEffect(AssetStep)),
      Effect.mapError((cause) => new WalletUnavailable({ cause })),
    ),
  overview: (address) =>
    Schema.encodeEffect(OverviewCall)({ address }).pipe(
      Effect.flatMap((data) => Effect.tryPromise(() => overviewFn({ data }))),
      Effect.flatMap(Schema.decodeEffect(Overview)),
      Effect.mapError((cause) => new WalletUnavailable({ cause })),
    ),
  open: (claim, approval) =>
    Schema.encodeEffect(OpenCall)({ claim, approval }).pipe(
      Effect.flatMap((data) => Effect.tryPromise(() => openFn({ data }))),
      Effect.flatMap(Schema.decodeEffect(OpenStep)),
      Effect.mapError((cause) => new WalletUnavailable({ cause })),
    ),
  transfer: (order, approval) =>
    Schema.encodeEffect(TransferCall)({ order, approval }).pipe(
      Effect.flatMap((data) => Effect.tryPromise(() => transferFn({ data }))),
      Effect.flatMap(Schema.decodeEffect(TransferStep)),
      Effect.mapError((cause) => new WalletUnavailable({ cause })),
    ),
};
