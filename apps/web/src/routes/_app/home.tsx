import { useState } from "react";
import { Navigate, createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  type BackUpOutcome,
  type Holding,
  type SavedBackup,
  type SavedOutcome,
  assetKey,
  baseAsset,
} from "@workspace/wallet";
import * as Match from "effect/Match";

import { ActivityRow } from "@/components/activity-row";
import { BalanceHeader } from "@/components/balance-header";
import { HomeSkeleton } from "@/components/home-skeleton";
import { Screen } from "@/components/screen";
import { recentActivity } from "@/fixtures/activity";

export const Route = createFileRoute("/_app/home")({
  ssr: false,
  pendingMs: 0,
  pendingComponent: HomeSkeleton,
  loader: async ({ context }) => {
    const [overview, saved] = await Promise.all([
      context.walletClient.overview(),
      context.walletClient.saved(),
    ]);

    return { overview, backup: savedBackup(saved) };
  },
  component: HomeScreen,
});

const savedBackup = (saved: SavedOutcome): SavedBackup =>
  Match.valueTags(saved, {
    SavedWallet: ({ backup }) => backup,
    NoWallet: (): SavedBackup => "none",
    UnsupportedDevice: (): SavedBackup => "none",
  });

const backUpRefusal = (
  outcome: Exclude<BackUpOutcome, { _tag: "BackupStored" }>,
) =>
  Match.valueTags(outcome, {
    BackupUnsupported: () =>
      "Este navegador no permite respaldar tu cuenta con passkey.",
    PasskeyCancelled: () => "No se creó la passkey. Inténtalo de nuevo.",
    PasskeyFailed: () => "No pudimos crear la passkey. Inténtalo de nuevo.",
    ChallengeRefused: () => "El respaldo tardó demasiado. Inténtalo de nuevo.",
    RegistrationRefused: () =>
      "No pudimos guardar el respaldo. Inténtalo de nuevo.",
    NoWallet: () => "Este navegador no puede leer tu llave de forma segura.",
    UnsupportedDevice: () =>
      "Este navegador no puede leer tu llave de forma segura.",
    Offline: () => "Sin conexión. Inténtalo de nuevo.",
  });

function HomeScreen() {
  const { overview, backup } = Route.useLoaderData();

  return Match.valueTags(overview, {
    NoWallet: () => <Navigate to="/" replace />,
    NotOpened: () => <Navigate to="/create-account" replace />,
    Holding: (holding) => <Home holding={holding} backup={backup} />,
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

function Home({ holding, backup }: { holding: Holding; backup: SavedBackup }) {
  const dollars =
    holding.balances.find(
      (balance) => assetKey(balance.asset) === assetKey(baseAsset),
    )?.amount ?? 0n;

  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-10 px-5 pt-2 pb-30">
        <BalanceHeader username={holding.profile.username} dollars={dollars} />
        {backup === "stored" ? null : <BackupNotice backup={backup} />}
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
    </Screen>
  );
}

function BackupNotice({ backup }: { backup: Exclude<SavedBackup, "stored"> }) {
  const router = useRouter();
  const { walletClient } = Route.useRouteContext();
  const [backingUp, setBackingUp] = useState(false);
  const [problem, setProblem] = useState<string>();

  const backUp = async () => {
    setBackingUp(true);
    setProblem(undefined);

    const outcome = await walletClient.backUp();

    await Match.value(outcome).pipe(
      Match.tag("BackupStored", () => router.invalidate()),
      Match.orElse((refused) => setProblem(backUpRefusal(refused))),
    );

    setBackingUp(false);
  };

  return (
    <section
      aria-labelledby="backup-title"
      className="flex flex-col gap-3 rounded-lg bg-muted p-4"
    >
      <h2 id="backup-title" className="text-label-lg">
        Tu cuenta no tiene respaldo
      </h2>
      <p className="text-body text-muted-foreground">
        {backup === "deviceOnly"
          ? "Este navegador no permite respaldar con passkey. Tu llave solo está en este dispositivo."
          : "Si pierdes este dispositivo, pierdes tu cuenta. Respáldala con una passkey."}
      </p>
      {problem ? (
        <p role="alert" className="text-body text-destructive">
          {problem}
        </p>
      ) : null}
      <Button className="w-full" disabled={backingUp} onClick={backUp}>
        {backingUp ? "Respaldando…" : "Respaldar con passkey"}
      </Button>
    </section>
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
      <main className="flex flex-1 flex-col justify-end gap-2 px-5 pb-30">
        <h1 className="font-display text-h1">{title}</h1>
        <p className="text-body text-muted-foreground">{message}</p>
        <Button className="mt-4 w-full" disabled={busy} onClick={onAction}>
          {action}
        </Button>
      </main>
    </Screen>
  );
}
