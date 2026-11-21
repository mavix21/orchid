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
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { amountLabel } from "@/send/money";
import type { WalletRun } from "@/send/use-wallet-run";

import { LinkResultScreen, LinkWorking } from "./link-result";
import {
  type RecoverableLink,
  cancelLinkResult,
  recoveryDeviceFailure,
} from "./outcomes";

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
        <DrawerHeader>
          <DrawerTitle>
            ¿Recuperar {amountLabel(link.amount, link.asset)}?
          </DrawerTitle>
          <DrawerDescription>
            {created === undefined ? "" : `Es el link creado el ${created}. `}
            El link dejará de funcionar. Si nadie lo usó, el dinero vuelve a tu
            cuenta.
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
      </DrawerContent>
    </Drawer>
  );
}

export function RecoveryAnswer({
  answer,
  link,
  onAgain,
  onDone,
}: {
  answer: WalletRun<CancelPaymentLinkOutcome>;
  link: RecoverableLink;
  onAgain: () => void;
  onDone?: () => void;
}) {
  if (answer.working || Option.isNone(answer.answered))
    return <LinkWorking label="Recuperando tu dinero…" />;

  return Exit.match(answer.answered.value, {
    onFailure: () => (
      <LinkResultScreen
        outcome="DeviceFailure"
        screen={recoveryDeviceFailure}
        onAgain={onAgain}
        onEdit={onAgain}
        onCheck={onAgain}
        onDone={onDone}
      />
    ),
    onSuccess: (outcome) => (
      <LinkResultScreen
        outcome={outcome._tag}
        screen={cancelLinkResult(outcome, link)}
        onAgain={onAgain}
        onEdit={onAgain}
        onCheck={onAgain}
        onDone={onDone}
      />
    ),
  });
}
