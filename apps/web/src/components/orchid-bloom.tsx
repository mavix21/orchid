import { cn } from "@workspace/ui/lib/utils";

type OrchidMotion = "bloom" | "flourish" | "rest" | "breathe";

type PartStyle = React.CSSProperties & {
  "--angle": string;
  "--stagger": string;
  "--bud-x": string;
  "--bud-y": string;
};

type HeroStyle = React.CSSProperties & {
  "--glow-delay": string;
  "--reveal-delay": string;
};

interface FlowerPart {
  readonly kind: "sepal" | "petal";
  readonly angle: number;
  readonly stagger: number;
  readonly budX: number;
  readonly budY: number;
}

const sepalPath = "M100 96C85 84 80 44 100 20C120 44 115 84 100 96Z";

const petalPath =
  "M100 96C84 92 56 72 58 44C60 22 82 14 100 14C118 14 140 22 142 44C144 72 116 92 100 96Z";

const lipPath =
  "M100 98C88 98 84 112 90 124C93 130 97 136 100 142C103 136 107 130 110 124C116 112 112 98 100 98Z";

const parts: ReadonlyArray<FlowerPart> = [
  { kind: "sepal", angle: -148, stagger: 0.05, budX: 0.8, budY: 0.78 },
  { kind: "sepal", angle: 148, stagger: 0.05, budX: 0.8, budY: 0.78 },
  { kind: "sepal", angle: 0, stagger: 0, budX: 0.8, budY: 0.78 },
  { kind: "petal", angle: -70, stagger: 0.1, budX: 0.24, budY: 0.48 },
  { kind: "petal", angle: 70, stagger: 0.1, budX: 0.24, budY: 0.48 },
];

const partMotion: Record<OrchidMotion, string> = {
  bloom: "orchid-part orchid-unfold",
  flourish: "orchid-part orchid-flourish",
  rest: "orchid-part",
  breathe: "orchid-part",
};

export function OrchidBloom({
  motion,
  className,
}: {
  motion: OrchidMotion;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 200 200"
      aria-hidden="true"
      className={cn(motion === "breathe" && "orchid-breathe", className)}
    >
      {parts.map(({ kind, angle, stagger, budX, budY }) => {
        const style: PartStyle = {
          "--angle": `${angle}deg`,
          "--stagger": `${stagger}s`,
          "--bud-x": `${budX}`,
          "--bud-y": `${budY}`,
        };

        return (
          <path
            key={angle}
            className={cn(
              kind === "sepal" ? "orchid-sepal" : "fill-primary",
              partMotion[motion],
            )}
            style={style}
            d={kind === "sepal" ? sepalPath : petalPath}
          />
        );
      })}
      <g className={cn("orchid-lip", motion === "bloom" && "orchid-lip-open")}>
        <path className="fill-primary-pressed" d={lipPath} />
        <circle
          className="fill-primary-foreground opacity-90"
          cx="100"
          cy="92"
          r="5"
        />
      </g>
    </svg>
  );
}

export function BloomHero({
  motion,
  label,
  amount,
  children,
}: {
  motion: OrchidMotion;
  label: string;
  amount?: string;
  children?: React.ReactNode;
}) {
  const celebrates = motion === "bloom" || motion === "flourish";

  const style: HeroStyle = {
    "--glow-delay": motion === "bloom" ? "1s" : "0.05s",
    "--reveal-delay": motion === "bloom" ? "1.15s" : "0.25s",
  };

  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-6 text-center"
      style={style}
    >
      <div className={cn("relative", motion === "bloom" && "orchid-fall")}>
        <div
          aria-hidden="true"
          className={cn(
            "orchid-glow absolute -inset-1/4 rounded-full",
            celebrates && "orchid-glow-in",
          )}
        />
        <OrchidBloom motion={motion} className="relative size-56" />
      </div>
      <div
        className={cn(
          "flex flex-col items-center gap-1",
          celebrates && "orchid-reveal",
        )}
      >
        {amount === undefined ? (
          <h1 className="font-display text-h2 text-balance">{label}</h1>
        ) : (
          <>
            <p className="text-label text-muted-foreground">{label}</p>
            <p className="font-display text-display">{amount}</p>
          </>
        )}
        {children}
      </div>
    </section>
  );
}
