import { HumanCheckToken } from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeToken = Schema.decodeUnknownOption(HumanCheckToken);

const tokenWaitMillis = 10_000;

let held = Option.none<HumanCheckToken>();

const arrivals = new Set<() => void>();
const takes = new Set<() => void>();

const settle = (listeners: Set<() => void>) => {
  for (const listener of listeners) listener();
};

export const offerHumanCheck = (text: string) => {
  held = decodeToken(text);
  settle(arrivals);
};

export const expireHumanCheck = () => {
  held = Option.none();
};

export const onHumanCheckTaken = (listener: () => void) => {
  takes.add(listener);

  return () => {
    takes.delete(listener);
  };
};

const arrival = () =>
  new Promise<void>((resolve) => {
    const arrived = () => {
      arrivals.delete(arrived);
      resolve();
    };

    arrivals.add(arrived);
    setTimeout(arrived, tokenWaitMillis);
  });

export const takeHumanCheck = async (): Promise<
  Option.Option<HumanCheckToken>
> => {
  if (Option.isNone(held)) await arrival();

  const taken = held;

  held = Option.none();
  settle(takes);

  return taken;
};
