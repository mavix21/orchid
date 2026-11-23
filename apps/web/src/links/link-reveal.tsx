import { CheckIcon, CopyIcon, ShareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@workspace/ui/components/drawer";
import type { PaymentLinkRevealed, SavedLinkTarget } from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { amountLabel } from "@/send/money";
import { useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";
import { displayLock } from "@/wallet/display-lock";

import { type Delivery, delivered, nextDelivery } from "./link-step";
import { type RevealRefusal, revealResult } from "./outcomes";
import {
  type ShareResult,
  type ShareableLink,
  copyLink,
  nativeShareAvailable,
  shareLink,
} from "./share-link";

type Reveal = Data.TaggedEnum<{
  Closed: {};
  Opening: { readonly target: SavedLinkTarget };
  Opened: {
    readonly link: PaymentLinkRevealed;
    readonly delivery: Delivery;
    readonly delivering: boolean;
  };
  Refused: {
    readonly target: SavedLinkTarget;
    readonly outcome: RevealRefusal;
  };
}>;

const Reveal = Data.taggedEnum<Reveal>();

const deliveryNote = (delivery: Delivery) =>
  Match.value(delivery).pipe(
    Match.when("none", () => Option.none<string>()),
    Match.when("shared", () => Option.some("Link compartido.")),
    Match.when("copied", () =>
      Option.some("Link copiado. Pégalo en el chat de quien recibe."),
    ),
    Match.when("dismissed", () =>
      Option.some("Aún no lo compartiste. Puedes intentarlo de nuevo."),
    ),
    Match.when("failed", () =>
      Option.some("No se pudo completar. Inténtalo de nuevo."),
    ),
    Match.exhaustive,
  );

export function DeliveryNote({ delivery }: { delivery: Delivery }) {
  return (
    <p
      role="status"
      className="flex min-h-6 items-center justify-center gap-2 text-label text-accent-foreground"
    >
      {delivered(delivery) ? <CheckIcon className="size-5 shrink-0" /> : null}
      {Option.getOrUndefined(deliveryNote(delivery))}
    </p>
  );
}

export function DeliveryActions({
  delivering,
  onShare,
  onCopy,
}: {
  delivering: boolean;
  onShare: () => void;
  onCopy: () => void;
}) {
  return (
    <>
      {nativeShareAvailable() ? (
        <Button
          className="w-full"
          onClick={onShare}
          disabled={delivering}
          data-testid="share-link"
        >
          <ShareIcon />
          Compartir link
        </Button>
      ) : null}
      <Button
        className="w-full"
        variant={nativeShareAvailable() ? "secondary" : "default"}
        onClick={onCopy}
        disabled={delivering}
        data-testid="copy-link"
      >
        <CopyIcon />
        Copiar link
      </Button>
    </>
  );
}

export function useLinkReveal() {
  const task = useWalletTask();
  const [reveal, setReveal] = useState<Reveal>(Reveal.Closed());
  const stopTask = useRef(task.stop);

  stopTask.current = task.stop;

  useEffect(
    () =>
      displayLock.subscribe(() => {
        if (Predicate.isTagged(displayLock.state(), "Unlocked")) return;

        stopTask.current();
        setReveal(Reveal.Closed());
      }),
    [],
  );

  const open = (target: SavedLinkTarget) => {
    setReveal(Reveal.Opening({ target }));
    task.run(walletEffects.revealPaymentLink(target), (answer) =>
      setReveal(
        Predicate.isTagged(answer, "PaymentLinkRevealed")
          ? Reveal.Opened({ link: answer, delivery: "none", delivering: false })
          : Reveal.Refused({ target, outcome: answer }),
      ),
    );
  };

  const deliver = (send: (link: ShareableLink) => Promise<ShareResult>) => {
    if (!Predicate.isTagged(reveal, "Opened")) return;

    const { link } = reveal;

    setReveal(Reveal.Opened({ ...reveal, delivering: true }));
    void send(link).then((result) =>
      setReveal((current) =>
        Predicate.isTagged(current, "Opened") && current.link === link
          ? Reveal.Opened({
              link,
              delivery: nextDelivery(current.delivery, result),
              delivering: false,
            })
          : current,
      ),
    );
  };

  const close = () => {
    task.stop();
    setReveal(Reveal.Closed());
  };

  return {
    reveal,
    open,
    share: () => deliver(shareLink),
    copy: () => deliver(copyLink),
    close,
  };
}

export function LinkShareDrawer({
  sharing,
  onRecover,
}: {
  sharing: ReturnType<typeof useLinkReveal>;
  onRecover: (target: SavedLinkTarget) => void;
}) {
  const { reveal, open, share, copy, close } = sharing;

  return (
    <Drawer
      open={!Predicate.isTagged(reveal, "Closed")}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      showSwipeHandle
    >
      <DrawerContent data-testid="link-share-drawer">
        {Match.valueTags(reveal, {
          Closed: () => null,
          Opening: () => (
            <DrawerHeader>
              <DrawerTitle>Abriendo tu link…</DrawerTitle>
              <DrawerDescription>
                Confirma con tu passkey para compartirlo.
              </DrawerDescription>
            </DrawerHeader>
          ),
          Opened: ({ link, delivery, delivering }) => (
            <>
              <DrawerHeader>
                <DrawerTitle>Comparte tu link</DrawerTitle>
                <DrawerDescription>
                  {`Quien abra el link podrá recibir ${amountLabel(link.amount, link.asset)}.`}
                </DrawerDescription>
              </DrawerHeader>
              <DeliveryNote delivery={delivery} />
              <DrawerFooter>
                <DeliveryActions
                  delivering={delivering}
                  onShare={share}
                  onCopy={copy}
                />
                <Button className="w-full" variant="ghost" onClick={close}>
                  Cerrar
                </Button>
              </DrawerFooter>
            </>
          ),
          Refused: ({ target, outcome }) => {
            const screen = revealResult(outcome);

            return (
              <>
                <DrawerHeader>
                  <DrawerTitle>{screen.title}</DrawerTitle>
                  <DrawerDescription
                    data-testid="reveal-outcome"
                    data-outcome={outcome._tag}
                  >
                    {screen.message}
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerFooter>
                  {screen.action === "retry" ? (
                    <Button className="w-full" onClick={() => open(target)}>
                      Reintentar
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={() => {
                        close();
                        onRecover(target);
                      }}
                    >
                      {`Recuperar ${amountLabel(target.amount, target.asset)}`}
                    </Button>
                  )}
                  <Button className="w-full" variant="ghost" onClick={close}>
                    Cerrar
                  </Button>
                </DrawerFooter>
              </>
            );
          },
        })}
      </DrawerContent>
    </Drawer>
  );
}
