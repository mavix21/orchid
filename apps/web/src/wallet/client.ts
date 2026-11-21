import {
  type KeyStore,
  browserKeyStore,
  browserPasskeys,
  makeWalletEffects,
} from "@workspace/wallet";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { port } from "./port.functions";
import { markWalletOnDevice } from "./wallet-cookie";

const deviceKeyStore: KeyStore = {
  read: () =>
    browserKeyStore
      .read()
      .pipe(
        Effect.tap((stored) =>
          Effect.sync(() => markWalletOnDevice(Option.isSome(stored))),
        ),
      ),
  write: (wallet) =>
    browserKeyStore
      .write(wallet)
      .pipe(Effect.tap(() => Effect.sync(() => markWalletOnDevice(true)))),
  clearLink: (expected) =>
    browserKeyStore.clearLink
      ? browserKeyStore.clearLink(expected)
      : Effect.void,
};

export const walletEffects = makeWalletEffects(
  port,
  deviceKeyStore,
  browserPasskeys,
);
