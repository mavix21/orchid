import { createFileRoute } from "@tanstack/react-router";

import { ActivityRow } from "@/components/activity-row";
import { BalanceHeader } from "@/components/balance-header";
import { Screen } from "@/components/screen";
import { TabBar } from "@/components/tab-bar";
import { recentActivity } from "@/fixtures/activity";

export const Route = createFileRoute("/inicio")({
  component: Inicio,
});

function Inicio() {
  return (
    <Screen>
      <main className="flex flex-1 flex-col gap-10 px-5 pt-2 pb-30">
        <BalanceHeader />
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
