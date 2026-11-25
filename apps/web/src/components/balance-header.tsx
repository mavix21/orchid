import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  LinkIcon,
  PlusIcon,
  QrCodeIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

import { ActionTile } from "@/components/action-tile";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";

const unitsPerDollar = 10_000_000n;
const unitsPerCent = 100_000n;

export function BalanceHeader({
  username,
  dollars,
}: {
  username: string;
  dollars: bigint;
}) {
  const whole = (dollars / unitsPerDollar).toLocaleString("es-PE");

  const cents = ((dollars % unitsPerDollar) / unitsPerCent)
    .toString()
    .padStart(2, "0");

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <UserAvatar profile={me} />
        <p className="flex-1 truncate text-label-lg">@{username}</p>
        <button
          type="button"
          aria-label="Mi código QR"
          className="rounded-sm text-icon-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <QrCodeIcon className="size-6" />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <p className="flex items-baseline font-display text-display">
          <span>${whole}</span>
          <span className="text-muted-foreground">.{cents}</span>
        </p>
      </div>
      <div className="flex gap-2">
        <ActionTile
          label="Enviar"
          icon={<ArrowUpRightIcon />}
          render={<Link to="/send" data-testid="open-send" />}
        />
        <ActionTile label="Cobrar" icon={<LinkIcon />} />
        <ActionTile
          label="Recibir"
          icon={<ArrowDownLeftIcon />}
          render={<Link to="/receive" data-testid="open-receive" />}
        />
        <ActionTile label="Agregar" icon={<PlusIcon />} />
      </div>
    </section>
  );
}
