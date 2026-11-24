import {
  ArrowLeftRightIcon,
  ClockIcon,
  HouseIcon,
  UserRoundIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

const itemClass =
  "flex h-12 w-16 items-center justify-center rounded-full text-icon-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-accent aria-[current=page]:text-icon-accent [&_svg]:size-6";

export function TabBar() {
  return (
    <nav
      aria-label="Principal"
      className="fixed bottom-safe left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-card p-1"
    >
      <Link to="/home" aria-label="Inicio" className={itemClass}>
        <HouseIcon />
      </Link>
      <button type="button" aria-label="Swap" className={itemClass}>
        <ArrowLeftRightIcon />
      </button>
      <Link to="/activity" aria-label="Actividad" className={itemClass}>
        <ClockIcon />
      </Link>
      <button type="button" aria-label="Perfil" className={itemClass}>
        <UserRoundIcon />
      </button>
    </nav>
  );
}
