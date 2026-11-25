import type { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Directory } from "../src/server/Directory.server";
import { RateLimits } from "../src/server/RateLimits.server";
import { Wallet } from "../src/server/Wallet.server";
import {
  claimFor,
  fakeChain,
  fakeHumanCheck,
  settingsFor,
  stores,
} from "./wallet-harness";

export const walletWithDepositCap = (cap: number) =>
  Layer.fresh(
    Wallet.serviceLayer.pipe(
      Layer.provide(stores),
      Layer.provide(RateLimits.unlimited),
      Layer.provide(fakeChain),
      Layer.provide(fakeHumanCheck),
      Layer.provide(settingsFor(undefined, cap)),
    ),
  );

export const enrollUnopened = (key: Keypair, name: string) => {
  const claim = claimFor(key, name);

  return Directory.use((d) => d.enrollUnopened(claim, () => Effect.void)).pipe(
    Effect.as(claim),
  );
};
