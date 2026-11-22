import {
  type CorruptDeviceWallet,
  type KeyStore,
  KeyStoreUnavailable,
  browserKeyStore,
  browserPasskeys,
  makeWalletEffects,
} from "@workspace/wallet";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { port } from "./port.functions";
import { markWalletOnDevice } from "./wallet-cookie";

const failClosed = <A>(
  effect: Effect.Effect<A, KeyStoreUnavailable | CorruptDeviceWallet>,
) =>
  effect.pipe(
    Effect.catchTag("CorruptDeviceWallet", (cause) =>
      Effect.fail(new KeyStoreUnavailable({ cause })),
    ),
  );

const deviceKeyStore: KeyStore = {
  read: () =>
    Effect.fail(
      new KeyStoreUnavailable({
        cause: new Error("Local wallet requires passkey verification"),
      }),
    ),
  write: () =>
    Effect.fail(
      new KeyStoreUnavailable({
        cause: new Error("Local wallet requires passkey verification"),
      }),
    ),
  readPublic: () =>
    failClosed(browserKeyStore.readPublic()).pipe(
      Effect.tap((stored) =>
        Effect.sync(() => markWalletOnDevice(Option.isSome(stored))),
      ),
    ),
  updatePublic: (update) =>
    failClosed(browserKeyStore.updatePublic(update)).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (Option.isSome(result)) markWalletOnDevice(true);
        }),
      ),
    ),
};

export const walletEffects = makeWalletEffects(
  port,
  deviceKeyStore,
  browserPasskeys,
);
