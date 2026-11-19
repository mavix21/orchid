import type { WalletClient } from "@workspace/wallet";

const loadClient = () =>
  import("./client").then(({ walletClient }) => walletClient);

export const walletClient: WalletClient = {
  overview: () => loadClient().then((client) => client.overview()),
  saved: () => loadClient().then((client) => client.saved()),
  create: (usernameText) =>
    loadClient().then((client) => client.create(usernameText)),
  backUp: () => loadClient().then((client) => client.backUp()),
  restore: () => loadClient().then((client) => client.restore()),
  send: (intent) => loadClient().then((client) => client.send(intent)),
};
