import { cn } from "@workspace/ui/lib/utils";

type PetalStyle = React.CSSProperties & {
  "--angle": string;
  "--delay": string;
};

interface Petal {
  readonly path: string;
  readonly angle: number;
  readonly delay: number;
  readonly opacity: number;
}

const sepal = "M100 100C86 76 88 32 100 18C112 32 114 76 100 100Z";
const wing = "M100 100C62 84 64 26 100 22C136 26 138 84 100 100Z";

const petals: ReadonlyArray<Petal> = [
  { path: sepal, angle: 148, delay: 0.1, opacity: 0.7 },
  { path: sepal, angle: -148, delay: 0.1, opacity: 0.7 },
  { path: sepal, angle: 0, delay: 0, opacity: 0.8 },
  { path: wing, angle: 74, delay: 0.25, opacity: 0.95 },
  { path: wing, angle: -74, delay: 0.25, opacity: 0.95 },
];

export function OrchidBloom({
  stage,
  className,
}: {
  stage: "bud" | "bloom";
  className?: string;
}) {
  const lip = stage === "bloom" ? "orchid-lip-open" : "orchid-lip";

  return (
    <svg
      viewBox="0 0 200 200"
      aria-hidden="true"
      className={cn(stage === "bud" && "orchid-bud", className)}
    >
      {petals.map(({ path, angle, delay, opacity }) => {
        const style: PetalStyle = {
          "--angle": `${angle}deg`,
          "--delay": `${delay}s`,
        };

        return (
          <path
            key={angle}
            className={stage === "bloom" ? "orchid-petal-open" : "orchid-petal"}
            d={path}
            fill="currentColor"
            fillOpacity={opacity}
            style={style}
          />
        );
      })}
      <path
        className={lip}
        d="M100 96C78 100 74 130 100 152C126 130 122 100 100 96Z"
      />
      <circle className={lip} cx="100" cy="94" r="7" />
    </svg>
  );
}

type FallStyle = React.CSSProperties & {
  "--x": string;
  "--size": string;
  "--drift": string;
  "--spin": string;
  "--delay": string;
  "--duration": string;
};

const falling = [
  { x: 8, size: 10, drift: 24, spin: 260, delay: 0.9, duration: 3.4 },
  { x: 20, size: 14, drift: -30, spin: -200, delay: 1.3, duration: 3.9 },
  { x: 33, size: 9, drift: 18, spin: 320, delay: 1.0, duration: 3.1 },
  { x: 47, size: 12, drift: -22, spin: -280, delay: 1.5, duration: 3.6 },
  { x: 60, size: 16, drift: 34, spin: 220, delay: 0.8, duration: 4.0 },
  { x: 72, size: 10, drift: -18, spin: -300, delay: 1.2, duration: 3.3 },
  { x: 84, size: 13, drift: 26, spin: 240, delay: 1.6, duration: 3.8 },
  { x: 92, size: 9, drift: -26, spin: -240, delay: 1.1, duration: 3.2 },
];

export function PetalShower() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {falling.map(({ x, size, drift, spin, delay, duration }) => {
        const style: FallStyle = {
          "--x": `${x}%`,
          "--size": `${size}px`,
          "--drift": `${drift}px`,
          "--spin": `${spin}deg`,
          "--delay": `${delay}s`,
          "--duration": `${duration}s`,
        };

        return <span key={x} className="orchid-fall" style={style} />;
      })}
    </div>
  );
}

type RiseStyle = React.CSSProperties & { "--delay": string };

export function Rise({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const style: RiseStyle = { "--delay": `${delay}s` };

  return (
    <div className={cn("orchid-rise", className)} style={style}>
      {children}
    </div>
  );
}
