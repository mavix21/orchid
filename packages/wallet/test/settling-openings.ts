import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { WalletPort } from "../src/contract";
import { settleHash, world } from "./wallet-harness";

export const settlingOpenings = (wallet: WalletPort): WalletPort => ({
  ...wallet,
  open: (claim, approvals) =>
    wallet.open(claim, approvals).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sealed = world.submitted.at(-1);

          if (Option.isSome(approvals) && sealed) settleHash(sealed.hash);
        }),
      ),
    ),
});
