import { useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

export type WalletRun<A> = {
  readonly working: boolean;
  readonly answered: Option.Option<Exit.Exit<A>>;
};

const idle = { working: false, answered: Option.none() };

export function useWalletRun<Arg, A>(run: (arg: Arg) => Effect.Effect<A>) {
  const [state, setState] = useState<WalletRun<A>>(idle);
  const running = useRef<Option.Option<Fiber.Fiber<void>>>(Option.none());

  const stop = () => {
    if (Option.isSome(running.current))
      Effect.runFork(Fiber.interrupt(running.current.value));

    running.current = Option.none();
  };

  useEffect(() => stop, []);

  const start = (arg: Arg) => {
    stop();
    setState({ working: true, answered: Option.none() });
    running.current = Option.some(
      Effect.runFork(
        run(arg).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() =>
              setState({ working: false, answered: Option.some(exit) }),
            ),
          ),
        ),
      ),
    );
  };

  const reset = () => {
    stop();
    setState(idle);
  };

  return { state, start, reset };
}
