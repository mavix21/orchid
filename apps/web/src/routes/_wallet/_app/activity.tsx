import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import type {
  ActivityCursor,
  ActivityEntry,
  ActivityOutcome,
  ActivityPage,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ActivityList } from "@/activity/activity-list";
import { NoEntries } from "@/activity/recent-activity";
import { Screen, ScreenNote, ScreenStatus } from "@/components/screen";
import { useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";
import { whenUnlocked } from "@/wallet/display-lock";
import { unavailableMessage } from "@/wallet/unavailable";

export const Route = createFileRoute("/_wallet/_app/activity")({
  ssr: false,
  pendingMs: 0,
  pendingComponent: ActivitySkeleton,
  loader: async ({ context, abortController }) => {
    await whenUnlocked(abortController.signal);

    return { activity: await context.walletClient.activity() };
  },
  component: AllActivity,
});

const skeletonRows = ["first", "second", "third", "fourth"];

function ActivityFrame({ children }: { children: React.ReactNode }) {
  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-4 px-5 pt-6 pb-30">
        <h1 className="font-display text-h1">Actividad</h1>
        {children}
      </main>
    </Screen>
  );
}

function ActivitySkeleton() {
  return (
    <ActivityFrame>
      <div
        aria-busy="true"
        aria-label="Cargando tu actividad"
        className="flex flex-col gap-1"
      >
        {skeletonRows.map((row) => (
          <div key={row} className="flex items-center gap-3 px-1 py-3">
            <Skeleton variant="avatar" className="size-10" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-4 w-14" />
          </div>
        ))}
      </div>
    </ActivityFrame>
  );
}

const activityProblem = (
  activity: Exclude<ActivityOutcome, { _tag: "ActivityPage" }>,
) =>
  Match.valueTags(activity, {
    NotOpened: () => "Tu cuenta aún se está activando.",
    InvalidAddress: () => "La llave guardada en este dispositivo no es válida.",
    NoWallet: () => "Este dispositivo no tiene una cuenta de Orchid.",
    UnsupportedDevice: () =>
      "Este navegador no puede leer tu llave de forma segura.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    SessionRequired: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

function AllActivity() {
  const { activity } = Route.useLoaderData();
  const loadedAt = Route.useMatch({ select: (match) => match.updatedAt });

  if (!Predicate.isTagged(activity, "ActivityPage"))
    return <ActivityProblem message={activityProblem(activity)} />;

  return (
    <ActivityFrame>
      {activity.entries.length === 0 ? (
        <NoEntries />
      ) : (
        <ActivityPages key={loadedAt} first={activity} />
      )}
    </ActivityFrame>
  );
}

type Loaded = {
  readonly entries: ReadonlyArray<ActivityEntry>;
  readonly next: Option.Option<ActivityCursor>;
};

function ActivityPages({ first }: { first: ActivityPage }) {
  const task = useWalletTask();

  const [loaded, setLoaded] = useState<Loaded>({
    entries: first.entries,
    next: Option.fromUndefinedOr(first.next),
  });

  const [paging, setPaging] = useState<"idle" | "loading" | "failed">("idle");

  const loadMore = (cursor: ActivityCursor) => {
    setPaging("loading");
    task.run(walletEffects.activity(cursor), (answer) => {
      if (!Predicate.isTagged(answer, "ActivityPage")) {
        setPaging("failed");

        return;
      }

      setPaging("idle");

      setLoaded((current) => ({
        entries: [...current.entries, ...answer.entries],
        next: Option.fromUndefinedOr(answer.next),
      }));
    });
  };

  return (
    <>
      <ActivityList entries={loaded.entries} />
      {Option.match(loaded.next, {
        onNone: () => null,
        onSome: (cursor) => (
          <div className="flex flex-col gap-2">
            {paging === "failed" ? (
              <p role="alert" className="text-body text-muted-foreground">
                No pudimos cargar tu actividad
              </p>
            ) : null}
            <Button
              variant="secondary"
              className="w-full"
              disabled={paging === "loading"}
              onClick={() => loadMore(cursor)}
              data-testid="more-activity"
            >
              {Match.value(paging).pipe(
                Match.when("idle", () => "Ver más"),
                Match.when("loading", () => "Cargando…"),
                Match.when("failed", () => "Reintentar"),
                Match.exhaustive,
              )}
            </Button>
          </div>
        ),
      })}
    </>
  );
}

function ActivityProblem({ message }: { message: string }) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  return (
    <Screen>
      <ScreenStatus title="No pudimos cargar tu actividad">
        <ScreenNote>{message}</ScreenNote>
        <Button
          className="mt-4 w-full"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void router.invalidate().finally(() => setRetrying(false));
          }}
        >
          Reintentar
        </Button>
      </ScreenStatus>
    </Screen>
  );
}
