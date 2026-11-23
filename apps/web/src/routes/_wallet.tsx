import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { DisplayGate } from "@/wallet/display-gate";
import { deviceHoldsWallet } from "@/wallet/wallet-cookie";

export const Route = createFileRoute("/_wallet")({
  beforeLoad: () => {
    if (!deviceHoldsWallet()) throw redirect({ to: "/" });
  },
  component: WalletLayout,
});

function WalletLayout() {
  return (
    <DisplayGate>
      <Outlet />
    </DisplayGate>
  );
}
