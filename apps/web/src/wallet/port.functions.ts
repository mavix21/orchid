import { createServerFn } from "@tanstack/react-start";
import {
  AccountAddress,
  AssetOrder,
  AssetStep,
  Approval,
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

export const port: WalletPort = {
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
