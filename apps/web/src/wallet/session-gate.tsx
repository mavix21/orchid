import {
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";

import { SessionConfirmation } from "./session-confirmation";
import { useSessionLapsed } from "./session-lapse";
import { markWalletOnDevice } from "./wallet-cookie";

export function SessionGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();
  const lapsed = useSessionLapsed();
  const { walletClient } = useRouteContext({ from: "__root__" });

  return (
    <>
      {children}
      {lapsed ? (
        <SessionConfirmation
          client={walletClient}
          onConfirmed={() => void router.invalidate()}
          onNoWallet={() => {
            markWalletOnDevice(false);
            void navigate({ to: "/", replace: true });
          }}
        />
      ) : null}
    </>
  );
}
