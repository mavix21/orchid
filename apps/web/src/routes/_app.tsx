import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { TabBar } from "@/components/tab-bar";
import { deviceHoldsWallet } from "@/wallet/wallet-cookie";

export const Route = createFileRoute("/_app")({
  beforeLoad: () => {
    if (!deviceHoldsWallet()) throw redirect({ to: "/" });
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <>
      <Outlet />
      <TabBar />
    </>
  );
}
