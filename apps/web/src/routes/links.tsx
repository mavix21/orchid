import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@workspace/ui/components/item";
import { Skeleton } from "@workspace/ui/components/skeleton";
import type {
  OpenPaymentLink,
  PaymentLinksOutcome,
  ResolvePaymentLinkOutcome,
} from "@workspace/wallet";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import { Screen, ScreenActions } from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { type RecoverableLink, lostLinkMessage } from "@/links/outcomes";
import { RecoverDrawer, RecoveryAnswer } from "@/links/recovery";
import { amountLabel } from "@/send/money";
import { useWalletRun } from "@/send/use-wallet-run";
import { walletEffects } from "@/wallet";
import { unavailableMessage } from "@/wallet/unavailable";

export const Route = createFileRoute("/links")({
  ssr: false,
  pendingMs: 0,
  pendingComponent: () => <LinksFrame loading />,
  loader: async ({ context }) => {
    const latest = await context.walletClient.resolvePaymentLink();
    const links = await context.walletClient.paymentLinks();

    return { latest, links };
  },
  component: PaymentLinks,
});

class LatestNotice {
  constructor(
    readonly title: string,
    readonly message: string,
    readonly link: Option.Option<RecoverableLink>,
  ) {}
}

const latestNotice = (
  latest: ResolvePaymentLinkOutcome,
): Option.Option<LatestNotice> =>
  Match.valueTags(latest, {
    ResolvedPaymentLink: (resolved) =>
      Option.some(
        new LatestNotice(
          "Tu último link no se compartió",
          lostLinkMessage,
          Option.some(resolved),
        ),
      ),
    Pending: () =>
      Option.some(
        new LatestNotice(
          "Tu último link sigue en proceso",
          "Cuando termine, aparecerá aquí y podrás recuperar el dinero.",
          Option.none(),
        ),
      ),
    ApprovalOutstanding: () =>
      Option.some(
        new LatestNotice(
          "Tienes una operación en curso",
          "Cuando termine, tus links aparecerán aquí.",
          Option.none(),
        ),
      ),
    PaymentLinkReceiptInvalid: () =>
      Option.some(
        new LatestNotice(
          "No pudimos confirmar tu último link",
          "Si aparece abajo, puedes recuperar el dinero.",
          Option.none(),
        ),
      ),
    PaymentLinkNotFound: () => Option.none(),
    InvalidAddress: () => Option.none(),
    NoWallet: () => Option.none(),
    UnsupportedDevice: () => Option.none(),
    Offline: () => Option.none(),
    ServerUnreachable: () => Option.none(),
    LedgerUnreachable: () => Option.none(),
    ServiceFailed: () => Option.none(),
    InvalidResponse: () => Option.none(),
  });

const listProblem = (
  links: Exclude<PaymentLinksOutcome, { _tag: "OpenPaymentLinks" }>,
) =>
  Match.valueTags(links, {
    NotOpened: () => "Tu cuenta aún se está activando.",
    InvalidAddress: () => "La llave guardada en este dispositivo no es válida.",
    NoWallet: () => "Este dispositivo no tiene una cuenta de Orchid.",
    UnsupportedDevice: () =>
      "Este navegador no puede leer tu llave de forma segura.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

const createdOn = (link: OpenPaymentLink) =>
  DateTime.toDate(link.createdAt).toLocaleDateString("es-PE", {
    day: "numeric",
    month: "short",
  });

function LinksFrame({
  loading = false,
  children,
}: {
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Screen>
      <TopNav
        title="Links de pago"
        label="Atrás"
        icon={<ChevronLeftIcon absoluteStrokeWidth />}
        link={<Link to="/send" />}
      />
      {loading ? (
        <div
          aria-label="Cargando tus links"
          className="flex flex-col gap-3 px-5 pt-2"
        >
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        children
      )}
    </Screen>
  );
}

function PaymentLinks() {
  const { latest, links } = Route.useLoaderData();
  const router = useRouter();
  const recovery = useWalletRun(walletEffects.cancelPaymentLink);

  const [chosen, setChosen] = useState<Option.Option<RecoverableLink>>(
    Option.none(),
  );

  const [confirming, setConfirming] = useState(false);

  const [recovering, setRecovering] = useState<Option.Option<RecoverableLink>>(
    Option.none(),
  );

  const choose = (link: RecoverableLink) => {
    setChosen(Option.some(link));
    setConfirming(true);
  };

  const recover = (link: RecoverableLink) => {
    setRecovering(Option.some(link));
    recovery.start(link);
  };

  if (Option.isSome(recovering))
    return (
      <LinksFrame>
        <RecoveryAnswer
          answer={recovery.state}
          link={recovering.value}
          onAgain={() => recovery.start(recovering.value)}
          onDone={() => {
            recovery.reset();
            setRecovering(Option.none());
            void router.invalidate();
          }}
        />
      </LinksFrame>
    );

  return (
    <LinksFrame>
      {Match.value(links).pipe(
        Match.tag("OpenPaymentLinks", (open) => (
          <LinkList
            links={open.links}
            notice={latestNotice(latest)}
            onChoose={choose}
          />
        )),
        Match.orElse((problem) => (
          <ListProblem message={listProblem(problem)} />
        )),
      )}
      {Option.isSome(chosen) ? (
        <RecoverDrawer
          link={chosen.value}
          open={confirming}
          onOpenChange={setConfirming}
          onRecover={recover}
        />
      ) : null}
    </LinksFrame>
  );
}

function LinkList({
  links,
  notice,
  onChoose,
}: {
  links: ReadonlyArray<OpenPaymentLink>;
  notice: Option.Option<LatestNotice>;
  onChoose: (link: RecoverableLink) => void;
}) {
  const latest = Option.flatMap(notice, (found) => found.link);

  const listed = links.filter((link) =>
    Option.isNone(
      Option.filter(latest, (shown) => shown.balance === link.balance),
    ),
  );

  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-h1">Tus links abiertos</h1>
          <p className="text-body text-muted-foreground">
            Mientras nadie use un link, puedes recuperar su dinero.
          </p>
        </div>
        {Option.isSome(notice) ? (
          <section
            aria-labelledby="latest-link-title"
            data-testid="latest-link"
            className="flex flex-col gap-3 rounded-lg bg-muted p-4"
          >
            <h2 id="latest-link-title" className="text-label-lg">
              {notice.value.title}
            </h2>
            <p className="text-body text-muted-foreground">
              {notice.value.message}
            </p>
            {Option.isSome(latest) ? (
              <Button
                className="w-full"
                onClick={() => onChoose(latest.value)}
                data-testid="recover-latest-link"
              >
                Recuperar {amountLabel(latest.value.amount, latest.value.asset)}
              </Button>
            ) : null}
          </section>
        ) : null}
        {listed.length === 0 ? (
          <p className="text-body text-muted-foreground">
            {Option.isSome(latest)
              ? "No tienes otros links abiertos."
              : "No tienes links abiertos."}
          </p>
        ) : (
          <div role="list" className="flex flex-col gap-3">
            {listed.map((link) => (
              <Item key={link.balance} variant="outline" role="listitem">
                <ItemContent>
                  <ItemTitle className="whitespace-nowrap">
                    {amountLabel(link.amount, link.asset)}
                  </ItemTitle>
                  <ItemDescription>Creado el {createdOn(link)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onChoose(link)}
                    aria-label={`Recuperar ${amountLabel(link.amount, link.asset)}`}
                    data-testid="recover-link"
                  >
                    Recuperar
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </div>
        )}
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/send" />}
        >
          Crear un link
        </Button>
      </ScreenActions>
    </>
  );
}

function ListProblem({ message }: { message: string }) {
  const router = useRouter();

  return (
    <>
      <main
        role="status"
        className="flex flex-1 flex-col justify-end gap-2 px-5"
      >
        <h1 className="font-display text-h1">No pudimos cargar tus links</h1>
        <p className="text-body text-muted-foreground">{message}</p>
      </main>
      <ScreenActions>
        <Button className="w-full" onClick={() => void router.invalidate()}>
          Reintentar
        </Button>
      </ScreenActions>
    </>
  );
}
