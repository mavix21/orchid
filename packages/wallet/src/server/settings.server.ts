import * as Context from "effect/Context";
import type * as Redacted from "effect/Redacted";

export class WalletSettings extends Context.Service<
  WalletSettings,
  {
    readonly rpcUrl: string;
    readonly reserveSponsorSecret: Redacted.Redacted<string>;
    readonly feePayerSecret: Redacted.Redacted<string>;
    readonly passkeyOrigins: ReadonlyArray<string>;
  }
>()("@workspace/wallet/server/WalletSettings") {}
