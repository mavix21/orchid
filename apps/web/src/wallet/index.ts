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
  unlock: () => withWallet((wallet) => wallet.unlock()),
  reviewOpening: (usernameText) =>
    withWallet((wallet) => wallet.reviewOpening(usernameText)),
  confirmOpening: (shown) =>
    withWallet((wallet) => wallet.confirmOpening(shown)),
  backUp: () => withWallet((wallet) => wallet.backUp()),
  restore: () => withWallet((wallet) => wallet.restore()),
  cancelRestore: () => withWallet((wallet) => wallet.cancelRestore()),
  review: (intent) => withWallet((wallet) => wallet.review(intent)),
  confirm: (shown) => withWallet((wallet) => wallet.confirm(shown)),
  resume: (id) => withWallet((wallet) => wallet.resume(id)),
  reviewPaymentLink: (intent) =>
    withWallet((wallet) => wallet.reviewPaymentLink(intent)),
  confirmPaymentLink: (shown) =>
    withWallet((wallet) => wallet.confirmPaymentLink(shown)),
  paymentLinks: () => withWallet((wallet) => wallet.paymentLinks()),
  resolvePaymentLink: () => withWallet((wallet) => wallet.resolvePaymentLink()),
  revealPaymentLink: (target) =>
    withWallet((wallet) => wallet.revealPaymentLink(target)),
  reviewReclaim: (target) =>
    withWallet((wallet) => wallet.reviewReclaim(target)),
  confirmReclaim: (shown) =>
    withWallet((wallet) => wallet.confirmReclaim(shown)),
  paymentLink: (link, fragment) =>
    withWallet((wallet) => wallet.paymentLink(link, fragment)),
  reviewLinkReceive: (link, fragment) =>
    withWallet((wallet) => wallet.reviewLinkReceive(link, fragment)),
  confirmLinkReceive: (shown, fragment) =>
    withWallet((wallet) => wallet.confirmLinkReceive(shown, fragment)),
};

export const walletClient: WalletClient = {
  overview: () => Effect.runPromise(walletEffects.overview()),
  saved: () => Effect.runPromise(walletEffects.saved()),
  unlock: () => Effect.runPromise(walletEffects.unlock()),
  reviewOpening: (usernameText) =>
    Effect.runPromise(walletEffects.reviewOpening(usernameText)),
  confirmOpening: (shown) =>
    Effect.runPromise(walletEffects.confirmOpening(shown)),
  backUp: () => Effect.runPromise(walletEffects.backUp()),
  restore: () => Effect.runPromise(walletEffects.restore()),
  cancelRestore: () => Effect.runPromise(walletEffects.cancelRestore()),
  review: (intent) => Effect.runPromise(walletEffects.review(intent)),
  confirm: (shown) => Effect.runPromise(walletEffects.confirm(shown)),
  resume: (id) => Effect.runPromise(walletEffects.resume(id)),
  reviewPaymentLink: (intent) =>
    Effect.runPromise(walletEffects.reviewPaymentLink(intent)),
  confirmPaymentLink: (shown) =>
    Effect.runPromise(walletEffects.confirmPaymentLink(shown)),
  paymentLinks: () => Effect.runPromise(walletEffects.paymentLinks()),
  resolvePaymentLink: () =>
    Effect.runPromise(walletEffects.resolvePaymentLink()),
  revealPaymentLink: (target) =>
    Effect.runPromise(walletEffects.revealPaymentLink(target)),
  reviewReclaim: (target) =>
    Effect.runPromise(walletEffects.reviewReclaim(target)),
  confirmReclaim: (shown) =>
    Effect.runPromise(walletEffects.confirmReclaim(shown)),
  paymentLink: (link, fragment) =>
    Effect.runPromise(walletEffects.paymentLink(link, fragment)),
  reviewLinkReceive: (link, fragment) =>
    Effect.runPromise(walletEffects.reviewLinkReceive(link, fragment)),
  confirmLinkReceive: (shown, fragment) =>
    Effect.runPromise(walletEffects.confirmLinkReceive(shown, fragment)),
};
