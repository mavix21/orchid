import {
  type WalletClient,
  type WalletEffects,
  loadFromServer,
} from "@workspace/wallet";
import * as Effect from "effect/Effect";

const loaded = loadFromServer(() => import("./client")).pipe(
  Effect.map((client) => client.walletEffects),
);

const withWallet = <A>(use: (wallet: WalletEffects) => Effect.Effect<A>) =>
  loaded.pipe(
    Effect.flatMap(use),
    Effect.catch((failure) => Effect.succeed(failure)),
  );

export const walletEffects: WalletEffects = {
  overview: () => withWallet((wallet) => wallet.overview()),
  saved: () => withWallet((wallet) => wallet.saved()),
  create: (usernameText) => withWallet((wallet) => wallet.create(usernameText)),
  backUp: () => withWallet((wallet) => wallet.backUp()),
  restore: () => withWallet((wallet) => wallet.restore()),
  send: (intent) => withWallet((wallet) => wallet.send(intent)),
  review: (intent) => withWallet((wallet) => wallet.review(intent)),
  confirm: (shown) => withWallet((wallet) => wallet.confirm(shown)),
  resume: (id) => withWallet((wallet) => wallet.resume(id)),
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
