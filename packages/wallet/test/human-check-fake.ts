import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HumanCheckRefused } from "../src/contract";
import { HumanCheck } from "../src/server/HumanCheck.server";
import { world } from "./wallet-world";

export const bindingAllowed = Effect.succeed(Option.none<HumanCheckRefused>());

export const fakeHumanCheck = Layer.succeed(
  HumanCheck,
  HumanCheck.of({
    verify: () =>
      Effect.sync(() => {
        return world.humanCheckRefused
          ? Option.some(new HumanCheckRefused())
          : Option.none();
      }),
  }),
);
