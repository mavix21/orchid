import { useReducer } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@workspace/ui/components/drawer";

import type { CancelPaymentLinkOutcome } from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { amountLabel } from "@/send/money";
import { type Answer, useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";

import {
  LinkResultScreen,
  LinkWorking,
  ResultButton,
  ResultLink,
} from "./link-result";
import { type RecoverableLink, cancelLinkResult } from "./outcomes";

type Recovery = Data.TaggedEnum<{
  Idle: {};
  Recovering: { readonly link: RecoverableLink };
  Recovered: {
    readonly link: RecoverableLink;
    readonly answer: Answer<CancelPaymentLinkOutcome>;
  };
}>;

const Recovery = Data.taggedEnum<Recovery>();

export type RecoveryStarted = Exclude<
  Recovery,
  Data.TaggedEnum.Value<Recovery, "Idle">
>;

type RecoveryEvent = Data.TaggedEnum<{
  Started: { readonly link: RecoverableLink };
  Answered: { readonly answer: Answer<CancelPaymentLinkOutcome> };
  Reset: {};
}>;

const RecoveryEvent = Data.taggedEnum<RecoveryEvent>();

const reduceRecovery = (state: Recovery, event: RecoveryEvent): Recovery =>
  Match.valueTags(event, {
    Started: ({ link }) => Recovery.Recovering({ link }),
    Answered: ({ answer }) =>
      Predicate.isTagged(state, "Recovering")
        ? Recovery.Recovered({ link: state.link, answer })
        : state,
    Reset: () => Recovery.Idle(),
  });

export function useRecovery() {
  const task = useWalletTask();
  const [recovery, send] = useReducer(reduceRecovery, Recovery.Idle());

  const recover = (link: RecoverableLink) => {
    send(RecoveryEvent.Started({ link }));
    task.run(walletEffects.cancelPaymentLink(link), (answer) =>
      send(RecoveryEvent.Answered({ answer })),
    );
  };

  const reset = () => {
    task.stop();
    send(RecoveryEvent.Reset());
  };

  const started = Match.valueTags(recovery, {
    Idle: () => Option.none<RecoveryStarted>(),
    Recovering: (shown) => Option.some<RecoveryStarted>(shown),
    Recovered: (shown) => Option.some<RecoveryStarted>(shown),
  });

  return { started, recover, reset };
}

export function RecoverDrawer({
  link,
  created,
  open,
  onOpenChange,
  onRecover,
}: {
  link: RecoverableLink;
  created?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecover: (link: RecoverableLink) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent>
        <div className="flex flex-col gap-6">
          <DrawerHeader>
            <DrawerTitle>
              ¿Recuperar {amountLabel(link.amount, link.asset)}?
            </DrawerTitle>
            <DrawerDescription>
              {created === undefined ? "" : `Es el link creado el ${created}. `}
              El link dejará de funcionar. Si nadie lo usó, el dinero vuelve a
              tu cuenta.
            </DrawerDescription>
          </DrawerHeader>
          <DrawerFooter>
            <Button
              className="w-full"
              onClick={() => {
                onOpenChange(false);
                onRecover(link);
              }}
              data-testid="confirm-recover"
            >
              Recuperar dinero
            </Button>
            <Button
              className="w-full"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Mantener el link
            </Button>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function RecoveryAnswer({
  recovery,
  done,
  onRecover,
}: {
  recovery: RecoveryStarted;
  done: React.ReactNode;
  onRecover: (link: RecoverableLink) => void;
}) {
  if (Predicate.isTagged(recovery, "Recovering"))
    return <LinkWorking label="Recuperando tu dinero…" />;

  const { link, answer } = recovery;
  const screen = cancelLinkResult(answer, link);

  return (
    <LinkResultScreen outcome={answer._tag} screen={screen}>
      {Match.value(screen.action).pipe(
        Match.when("done", () => done),
        Match.when("home", () => (
          <ResultLink link={<Link to="/home" />}>Volver al inicio</ResultLink>
        )),
        Match.when("again", () => (
          <ResultButton onClick={() => onRecover(link)}>
            Reintentar
          </ResultButton>
        )),
        Match.when("check", () => (
          <ResultButton onClick={() => onRecover(link)}>
            Revisar de nuevo
          </ResultButton>
        )),
        Match.exhaustive,
      )}
    </LinkResultScreen>
  );
}
