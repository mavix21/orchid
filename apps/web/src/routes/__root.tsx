import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { WalletClient } from "@workspace/wallet";

import appCss from "@workspace/ui/globals.css?url";
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-2 px-5 pt-16">
      <h1 className="font-display text-h1">404</h1>
      <p className="text-body text-muted-foreground">
        No encontramos esta página.
      </p>
    </main>
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
