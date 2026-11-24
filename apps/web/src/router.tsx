import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { walletClient } from "./wallet";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    context: { walletClient },

    scrollRestoration: true,
    getScrollRestorationKey: (location) =>
      location.state.__TSR_key ?? location.pathname,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultGcTime: 30 * 60_000,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
