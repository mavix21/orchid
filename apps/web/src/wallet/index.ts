import type { WalletClient } from "@workspace/wallet";

const loadClient = () =>
  import("./client").then(({ walletClient }) => walletClient);

export const walletClient: WalletClient = {
  overview: () => loadClient().then((client) => client.overview()),
  create: (usernameText) =>
    loadClient().then((client) => client.create(usernameText)),
};
