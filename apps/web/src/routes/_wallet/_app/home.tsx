import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  type BackUpOutcome,
  type Holding,
  type SavedBackup,
  type SavedOutcome,
  type WalletUnavailable,
  assetKey,
  baseAsset,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import { ActivityRow } from "@/components/activity-row";
import { BalanceHeader } from "@/components/balance-header";
import { HomeSkeleton } from "@/components/home-skeleton";
import { Screen, ScreenNote, ScreenStatus } from "@/components/screen";
import { recentActivity } from "@/fixtures/activity";
import { whenUnlocked } from "@/wallet/display-lock";
import { OpeningFlow } from "@/wallet/opening-flow";
import { shownOverview } from "@/wallet/shown-overview";
import {
  retryable,
  unavailableMessage,
  unavailableNotice,
} from "@/wallet/unavailable";

export const Route = createFileRoute("/_wallet/_app/home")({
  ssr: false,
  pendingMs: 0,
  pendingComponent: HomeSkeleton,
  loader: async ({ context, abortController }) => {
    await whenUnlocked(abortController.signal);

    const [overview, saved] = await Promise.all([
      context.walletClient.overview(),
      context.walletClient.saved(),
    ]);

    return { overview: shownOverview(overview), backup: savedBackup(saved) };
  },
  component: HomeScreen,
});

const savedBackup = (saved: SavedOutcome): Option.Option<SavedBackup> =>
  Match.valueTags(saved, {
    SavedWallet: ({ backup }) => Option.some(backup),
    NoWallet: () => Option.some<SavedBackup>("none"),
    UnsupportedDevice: () => Option.some<SavedBackup>("none"),
    Offline: () => Option.none(),
    ServerUnreachable: () => Option.none(),
    LedgerUnreachable: () => Option.none(),
    ServiceFailed: () => Option.none(),
    InvalidResponse: () => Option.none(),
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
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

function HomeScreen() {
  const { overview, backup } = Route.useLoaderData();

  return Match.valueTags(overview, {
    Holding: (holding) => <Home holding={holding} backup={backup} />,
    NeedsReopening: ({ profile }) => <Reopening username={profile.username} />,
    InvalidAddress: () => (
      <Problem message="La llave guardada en este dispositivo no es válida." />
    ),
    UnsupportedDevice: () => (
      <Problem message="Este navegador no puede leer tu llave de forma segura." />
    ),
    Offline: (failure) => <Unavailable failure={failure} />,
    ServerUnreachable: (failure) => <Unavailable failure={failure} />,
    LedgerUnreachable: (failure) => <Unavailable failure={failure} />,
    ServiceFailed: (failure) => <Unavailable failure={failure} />,
    InvalidResponse: (failure) => <Unavailable failure={failure} />,
  });
}

function Home({
  holding,
  backup,
}: {
  holding: Holding;
  backup: Option.Option<SavedBackup>;
}) {
  const dollars =
    holding.balances.find(
      (balance) => assetKey(balance.asset) === assetKey(baseAsset),
    )?.amount ?? 0n;

  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-10 px-5 pt-2 pb-30">
        <BalanceHeader username={holding.profile.username} dollars={dollars} />
        {Option.isSome(backup) && backup.value !== "stored" ? (
          <BackupNotice />
        ) : null}
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

function BackupNotice() {
  const router = useRouter();
  const { walletClient } = Route.useRouteContext();
  const [backingUp, setBackingUp] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [stopped, setStopped] = useState(false);

  const backUp = async () => {
    setBackingUp(true);
    setProblem(undefined);

    const outcome = await walletClient.backUp();

    await Match.value(outcome).pipe(
      Match.tag("BackupStored", () => router.invalidate()),
      Match.orElse((refused) => {
        setProblem(backUpRefusal(refused));
        setStopped(!retryable(refused));
      }),
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
        Si pierdes este dispositivo, pierdes tu cuenta. Respáldala con una
        passkey.
      </p>
      {problem ? (
        <p role="alert" className="text-body text-destructive">
          {problem}
        </p>
      ) : null}
      <Button
        className="w-full"
        disabled={backingUp || stopped}
        onClick={backUp}
      >
        {backingUp ? "Respaldando…" : "Respaldar con passkey"}
      </Button>
    </section>
  );
}

function Reopening({ username }: { username: string }) {
  const router = useRouter();

  return (
    <Screen>
      <OpeningFlow username={username} onOpened={() => router.invalidate()} />
    </Screen>
  );
}

function Unavailable({ failure }: { failure: WalletUnavailable }) {
  const notice = unavailableNotice(failure);

  return notice.actionable ? (
    <Problem message={notice.message} />
  ) : (
    <Screen>
      <ScreenStatus title="No pudimos cargar tu cuenta">
        <ScreenNote>{notice.message}</ScreenNote>
      </ScreenStatus>
    </Screen>
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
      <ScreenStatus title={title}>
        <ScreenNote>{message}</ScreenNote>
        <Button className="mt-4 w-full" disabled={busy} onClick={onAction}>
          {action}
        </Button>
      </ScreenStatus>
    </Screen>
  );
}
