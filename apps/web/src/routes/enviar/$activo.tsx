import {
  ArrowLeftRightIcon,
  ChevronLeftIcon,
  UserRoundIcon,
  WalletIcon,
} from "lucide-react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { OptionRow } from "@/components/option-row";
import { Screen } from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { findAsset } from "@/fixtures/assets";

export const Route = createFileRoute("/enviar/$activo")({
  loader: ({ params }) => {
    const asset = findAsset(params.activo);

    if (!asset) throw notFound();

    return asset;
  },
  component: EnviarDestino,
});

// Figma 03e · Enviar · Destino · Mobile (97:3169). Destination screens are not built yet.
function EnviarDestino() {
  const asset = Route.useLoaderData();

  return (
    <Screen>
      <TopNav
        title={`Enviar ${asset.code}`}
        label="Atrás"
        icon={<ChevronLeftIcon absoluteStrokeWidth />}
        link={<Link to="/enviar" />}
      />
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">¿A dónde lo envías?</h1>
        <div className="flex flex-col gap-3">
          <OptionRow
            title="A un @usuario"
            description="Alguien que tenga Orchid"
            media={<UserRoundIcon />}
          />
          <OptionRow
            title="A una wallet crypto"
            description="Una dirección de la red Stellar"
            media={<WalletIcon />}
          />
          <OptionRow
            title="A un exchange"
            description="Binance o Lemon"
            media={<ArrowLeftRightIcon />}
          />
        </div>
      </main>
    </Screen>
  );
}
