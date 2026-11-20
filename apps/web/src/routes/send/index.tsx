import { XIcon } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { type Holding, assetKey } from "@workspace/wallet";
import * as Match from "effect/Match";

import { OptionRow } from "@/components/option-row";
import { Screen } from "@/components/screen";
import { TokenIcon } from "@/components/token-icon";
import { TopNav } from "@/components/top-nav";
import { amountLabel, assetCode } from "@/send/money";
import { SendUnavailable } from "@/send/send-unavailable";
import { shownOverview } from "@/wallet/shown-overview";

export const Route = createFileRoute("/send/")({
  ssr: false,
  pendingMs: 0,
  pendingComponent: () => <ChooseAssetFrame loading />,
  loader: async ({ context }) =>
    shownOverview(await context.walletClient.overview()),
  component: ChooseAsset,
});

function ChooseAssetFrame({
  loading = false,
  children,
}: {
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Screen>
      <TopNav
        title="Enviar"
        label="Cerrar"
        icon={<XIcon absoluteStrokeWidth />}
        link={<Link to="/home" />}
      />
      {loading ? (
        <div
          aria-label="Cargando tus saldos"
          className="flex flex-col gap-3 px-5 pt-2"
        >
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        children
      )}
    </Screen>
  );
}

function ChooseAsset() {
  const overview = Route.useLoaderData();

  return (
    <ChooseAssetFrame>
      {Match.valueTags(overview, {
        Holding: (holding) => <AssetChoices holding={holding} />,
        NeedsReopening: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        InvalidAddress: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        UnsupportedDevice: (unavailable) => (
          <SendUnavailable overview={unavailable} />
        ),
        Offline: (unavailable) => <SendUnavailable overview={unavailable} />,
      })}
    </ChooseAssetFrame>
  );
}

function AssetChoices({ holding }: { holding: Holding }) {
  const held = holding.balances.filter((balance) => balance.amount > 0n);

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
      <h1 className="font-display text-h1">¿Qué quieres enviar?</h1>
      {held.length === 0 ? (
        <p className="text-body text-muted-foreground">
          Aún no tienes saldo para enviar.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {held.map((balance) => (
            <OptionRow
              key={assetKey(balance.asset)}
              title={assetCode(balance.asset)}
              description={amountLabel(balance.amount, balance.asset)}
              media={<TokenIcon asset={balance.asset} />}
              mediaVariant="muted"
              render={
                <Link
                  to="/send/$asset"
                  params={{ asset: assetKey(balance.asset) }}
                />
              }
            />
          ))}
        </div>
      )}
    </main>
  );
}
