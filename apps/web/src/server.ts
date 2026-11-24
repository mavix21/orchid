import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { Wallet } from "@workspace/wallet/server";
import { runWallet } from "./server/wallet.server";
import { attendMessage } from "./server/work.server";

export default {
  fetch: createStartHandler(defaultStreamHandler),
  scheduled: async () => {
    await runWallet(Wallet.use((wallet) => wallet.sweep));
  },
  queue: async (batch: MessageBatch) => {
    await Promise.all(batch.messages.map(attendMessage));
  },
};
