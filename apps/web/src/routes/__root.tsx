import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { WalletClient } from "@workspace/wallet";

import appCss from "@workspace/ui/globals.css?url";
import { Screen, ScreenNote, ScreenStatus } from "@/components/screen";
import { ThemeProvider } from "@/components/theme-provider";
import { useDisplayLockLifecycle } from "@/wallet/display-lock";

export const Route = createRootRouteWithContext<{
  walletClient: WalletClient;
}>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      {
        title: "Orchid",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  notFoundComponent: () => (
    <Screen>
      <ScreenStatus title="404">
        <ScreenNote>No encontramos esta página.</ScreenNote>
      </ScreenStatus>
    </Screen>
  ),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  useDisplayLockLifecycle();

  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider defaultTheme="system" storageKey="theme">
          {children}
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
