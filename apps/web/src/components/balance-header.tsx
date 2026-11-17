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
import { balance, me } from "@/fixtures/account";

export function BalanceHeader() {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <UserAvatar profile={me} />
        <p className="flex-1 truncate text-label-lg">@{me.username}</p>
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
          <span>{balance.whole}</span>
          <span className="text-muted-foreground">{balance.cents}</span>
        </p>
        <p className="text-body text-muted-foreground">
          {balance.localEquivalent}
        </p>
      </div>
      <div className="flex gap-2">
        <ActionTile
          label="Enviar"
          icon={<ArrowUpRightIcon />}
          render={<Link to="/enviar" />}
        />
        <ActionTile label="Cobrar" icon={<LinkIcon />} />
        <ActionTile label="Recibir" icon={<ArrowDownLeftIcon />} />
        <ActionTile label="Agregar" icon={<PlusIcon />} />
      </div>
    </section>
  );
}
