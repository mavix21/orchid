import { XIcon } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { OptionRow } from "@/components/option-row";
import { Screen } from "@/components/screen";
import { TokenIcon } from "@/components/token-icon";
import { TopNav } from "@/components/top-nav";
import { assets } from "@/fixtures/assets";

export const Route = createFileRoute("/enviar/")({
  component: EnviarActivo,
});

// Figma 03d · Enviar · Activo · Mobile (97:3078).
function EnviarActivo() {
  return (
    <Screen>
      <TopNav
        title="Enviar"
        label="Cerrar"
        icon={<XIcon absoluteStrokeWidth />}
        link={<Link to="/inicio" />}
      />
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">¿Qué quieres enviar?</h1>
        <div className="flex flex-col gap-3">
          {assets.map((asset) => (
            <OptionRow
              key={asset.id}
              title={asset.code}
              description={`${asset.amount} · ${asset.localEquivalent}`}
              media={<TokenIcon asset={asset.id} />}
              mediaVariant="muted"
              render={
                <Link to="/enviar/$activo" params={{ activo: asset.id }} />
              }
            />
          ))}
        </div>
      </main>
    </Screen>
  );
}
