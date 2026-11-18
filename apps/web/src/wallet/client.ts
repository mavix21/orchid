import {
  browserKeyStore,
  browserPasskeys,
  makeWalletClient,
} from "@workspace/wallet";
import { port } from "./port.functions";

export const walletClient = makeWalletClient(
  port,
  browserKeyStore,
  browserPasskeys,
);
