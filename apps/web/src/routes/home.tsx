import { useState } from "react";
import { Navigate, createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { assetKey, baseAsset, type Holding } from "@workspace/wallet";
import * as Match from "effect/Match";

import { ActivityRow } from "@/components/activity-row";
import { BalanceHeader } from "@/components/balance-header";
import { Screen, ScreenActions } from "@/components/screen";
import { TabBar } from "@/components/tab-bar";
import { recentActivity } from "@/fixtures/activity";

export const Route = createFileRoute("/home")({
  ssr: false,
  loader: ({ context }) => context.walletClient.overview(),
  component: HomeScreen,
});

function HomeScreen() {
  return Match.valueTags(Route.useLoaderData(), {
    NoWallet: () => <Navigate to="/" replace />,
    NotOpened: () => <Navigate to="/create-account" replace />,
    Holding: (holding) => <Home holding={holding} />,
    NeedsReopening: ({ profile }) => <Reopening username={profile.username} />,
    InvalidAddress: () => (
      <Problem message="La llave guardada en este dispositivo no es válida." />
    ),
    UnsupportedDevice: () => (
      <Problem message="Este navegador no puede leer tu llave de forma segura." />
    ),
    Offline: () => <Problem message="Sin conexión. Inténtalo de nuevo." />,
  });
}

function Home({ holding }: { holding: Holding }) {
  const dollars =
    holding.balances.find(
      (balance) => assetKey(balance.asset) === assetKey(baseAsset),
    )?.amount ?? 0n;

  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-10 px-5 pt-2 pb-30">
        <BalanceHeader username={holding.profile.username} dollars={dollars} />
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-label-lg">Actividad</h2>
            <button
              type="button"
              className="rounded-xs text-label text-accent-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Ver todo
            </button>
          </div>
          <div role="list" className="flex flex-col gap-1">
            {recentActivity.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} />
            ))}
          </div>
        </section>
      </main>
      <TabBar />
    </Screen>
  );
}

function Reopening({ username }: { username: string }) {
  const router = useRouter();
  const { walletClient } = Route.useRouteContext();
  const [reopening, setReopening] = useState(false);

  const reopen = async () => {
    setReopening(true);
    await walletClient.create(username);
    await router.invalidate();
    setReopening(false);
  };

  return (
    <Notice
      title={`@${username} necesita reabrirse`}
      message="Tu cuenta se cerró por inactividad. Tu usuario sigue siendo tuyo."
      action={reopening ? "Reabriendo…" : "Reabrir cuenta"}
      busy={reopening}
      onAction={reopen}
    />
  );
}

function Problem({ message }: { message: string }) {
  const router = useRouter();

  return (
    <Notice
      title="No pudimos cargar tu cuenta"
      message={message}
      action="Reintentar"
      busy={false}
      onAction={() => router.invalidate()}
    />
  );
}

function Notice({
  title,
  message,
  action,
  busy,
  onAction,
}: {
  title: string;
  message: string;
  action: string;
  busy: boolean;
  onAction: () => void;
}) {
  return (
    <Screen>
      <main className="flex flex-1 flex-col justify-end gap-2 px-5 pb-6">
        <h1 className="font-display text-h1">{title}</h1>
        <p className="text-body text-muted-foreground">{message}</p>
      </main>
      <ScreenActions>
        <Button className="w-full" disabled={busy} onClick={onAction}>
          {action}
        </Button>
      </ScreenActions>
    </Screen>
  );
}
