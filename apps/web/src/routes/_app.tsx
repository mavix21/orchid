import { Outlet, createFileRoute } from "@tanstack/react-router";

import { TabBar } from "@/components/tab-bar";

export const Route = createFileRoute("/_app")({
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
