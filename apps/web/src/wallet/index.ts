import type { WalletClient, WalletEffects } from "@workspace/wallet";
import * as Effect from "effect/Effect";

const loaded = Effect.promise(() => import("./client")).pipe(
  Effect.map((client) => client.walletEffects),
);

export const walletEffects: WalletEffects = {
  overview: () => Effect.flatMap(loaded, (wallet) => wallet.overview()),
  saved: () => Effect.flatMap(loaded, (wallet) => wallet.saved()),
  create: (usernameText) =>
    Effect.flatMap(loaded, (wallet) => wallet.create(usernameText)),
  backUp: () => Effect.flatMap(loaded, (wallet) => wallet.backUp()),
  restore: () => Effect.flatMap(loaded, (wallet) => wallet.restore()),
  send: (intent) => Effect.flatMap(loaded, (wallet) => wallet.send(intent)),
  review: (intent) => Effect.flatMap(loaded, (wallet) => wallet.review(intent)),
  confirm: (shown) => Effect.flatMap(loaded, (wallet) => wallet.confirm(shown)),
  resume: (id) => Effect.flatMap(loaded, (wallet) => wallet.resume(id)),
};

export const walletClient: WalletClient = {
  overview: () => Effect.runPromise(walletEffects.overview()),
  saved: () => Effect.runPromise(walletEffects.saved()),
  create: (usernameText) =>
    Effect.runPromise(walletEffects.create(usernameText)),
  backUp: () => Effect.runPromise(walletEffects.backUp()),
  restore: () => Effect.runPromise(walletEffects.restore()),
  send: (intent) => Effect.runPromise(walletEffects.send(intent)),
  review: (intent) => Effect.runPromise(walletEffects.review(intent)),
  confirm: (shown) => Effect.runPromise(walletEffects.confirm(shown)),
  resume: (id) => Effect.runPromise(walletEffects.resume(id)),
};
