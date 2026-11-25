import { HumanCheckToken } from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeToken = Schema.decodeUnknownOption(HumanCheckToken);

const tokenWaitMillis = 10_000;

let held = Option.none<HumanCheckToken>();
let mounted = 0;

const changes = new Set<() => void>();
const takes = new Set<() => void>();

const settle = (listeners: Set<() => void>) => {
  for (const listener of listeners) listener();
};

export const offerHumanCheck = (text: string) => {
  held = decodeToken(text);
  settle(changes);
};

export const expireHumanCheck = () => {
  held = Option.none();
};

export const mountHumanCheck = () => {
  let active = true;

  mounted += 1;

  return () => {
    if (!active) return;

    active = false;
    mounted -= 1;
    settle(changes);
  };
};

export const onHumanCheckTaken = (listener: () => void) => {
  takes.add(listener);

  return () => {
    takes.delete(listener);
  };
};

const change = () =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      changes.delete(finish);
      resolve();
    };

    const timer = setTimeout(finish, tokenWaitMillis);

    changes.add(finish);
  });

export const takeHumanCheck = async (): Promise<
  Option.Option<HumanCheckToken>
> => {
  if (Option.isNone(held) && mounted > 0) await change();

  const taken = held;

  if (Option.isSome(taken)) {
    held = Option.none();
    settle(takes);
  }

  return taken;
};
