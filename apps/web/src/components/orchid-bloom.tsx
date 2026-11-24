import { cn } from "@workspace/ui/lib/utils";

type PartStyle = React.CSSProperties & {
  "--angle": string;
  "--delay": string;
  "--bud-x": string;
  "--bud-y": string;
};

interface FlowerPart {
  readonly kind: "sepal" | "petal";
  readonly angle: number;
  readonly delay: number;
  readonly budX: number;
  readonly budY: number;
}

const sepalPath = "M100 96C85 84 80 44 100 20C120 44 115 84 100 96Z";

const petalPath =
  "M100 96C84 92 56 72 58 44C60 22 82 14 100 14C118 14 140 22 142 44C144 72 116 92 100 96Z";

const petalVeins =
  "M100 90V30M100 88C92 74 84 56 80 36M100 88C108 74 116 56 120 36";

const parts: ReadonlyArray<FlowerPart> = [
  { kind: "sepal", angle: -148, delay: 0.4, budX: 0.8, budY: 0.78 },
  { kind: "sepal", angle: 148, delay: 0.4, budX: 0.8, budY: 0.78 },
  { kind: "sepal", angle: 0, delay: 0.35, budX: 0.8, budY: 0.78 },
  { kind: "petal", angle: -70, delay: 0.45, budX: 0.24, budY: 0.48 },
  { kind: "petal", angle: 70, delay: 0.45, budX: 0.24, budY: 0.48 },
];

export function OrchidBloom({
  stage,
  className,
}: {
  stage: "bud" | "bloom";
  className?: string;
}) {
  const part =
    stage === "bloom" ? "orchid-part orchid-unfold" : "orchid-folded";

  return (
    <svg
      viewBox="0 0 200 200"
      aria-hidden="true"
      className={cn(
        stage === "bloom" ? "orchid-emerge" : "orchid-breathe",
        className,
      )}
    >
      {parts.map(({ kind, angle, delay, budX, budY }) => {
        const style: PartStyle = {
          "--angle": `${angle}deg`,
          "--delay": `${delay}s`,
          "--bud-x": `${budX}`,
          "--bud-y": `${budY}`,
        };

        return kind === "sepal" ? (
          <path
            key={angle}
            className={cn("orchid-sepal", part)}
            style={style}
            d={sepalPath}
          />
        ) : (
          <g key={angle} className={part} style={style}>
            <path className="fill-primary" d={petalPath} />
            <path
              className="fill-none stroke-primary-pressed opacity-40"
              strokeWidth={1.5}
              strokeLinecap="round"
              d={petalVeins}
            />
          </g>
        );
      })}
      <g
        className={
          stage === "bloom" ? "orchid-lip orchid-lip-open" : "opacity-0"
        }
      >
        <path
          className="fill-primary-pressed"
          d="M98 100C86 92 70 98 74 112C77 122 90 120 96 112Z"
        />
        <path
          className="fill-primary-pressed"
          d="M102 100C114 92 130 98 126 112C123 122 110 120 104 112Z"
        />
        <path
          className="fill-primary-pressed"
          d="M100 104C88 104 84 118 91 130C94 135 91 143 84 150C93 150 98 145 100 138C102 145 107 150 116 150C109 143 106 135 109 130C116 118 112 104 100 104Z"
        />
        <path
          className="fill-primary-foreground opacity-90"
          d="M100 84C96 84 94 89 95 95C96 100 98 102 100 102C102 102 104 100 105 95C106 89 104 84 100 84Z"
        />
      </g>
    </svg>
  );
}

export function BloomHero({
  stage = "bloom",
  label,
  amount,
  children,
}: {
  stage?: "bud" | "bloom";
  label: string;
  amount?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div className="relative">
        {stage === "bloom" ? (
          <div
            aria-hidden="true"
            className="orchid-glow absolute -inset-1/4 rounded-full"
          />
        ) : null}
        <OrchidBloom stage={stage} className="relative size-56" />
      </div>
      <div
        className={cn(
          "flex flex-col items-center gap-1",
          stage === "bloom" && "orchid-reveal",
        )}
      >
        <p className="text-label text-muted-foreground">{label}</p>
        {amount === undefined ? null : (
          <p className="font-display text-display">{amount}</p>
        )}
        {children}
      </div>
    </section>
  );
}
