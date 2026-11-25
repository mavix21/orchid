import { ChevronLeftIcon } from "lucide-react";
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
  ListedPaymentLink,
  PaymentLinksOutcome,
  ReceivedPaymentLink,
  ResolvePaymentLinkOutcome,
  SavedLinkTarget,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import {
  Screen,
  ScreenActions,
  ScreenNote,
  ScreenStatus,
} from "@/components/screen";
import { TopNav } from "@/components/top-nav";
import { type RecoverableLink, lostLinkMessage } from "@/links/outcomes";
import { ResultButton } from "@/links/link-result";
import { LinkShareDrawer, useLinkReveal } from "@/links/link-reveal";
import { RecoveryAnswer, useRecovery } from "@/links/recovery";
import { amountLabel } from "@/send/money";
import { whenUnlocked } from "@/wallet/display-lock";
import { unavailableMessage } from "@/wallet/unavailable";

export const Route = createFileRoute("/_wallet/links")({
  ssr: false,
  pendingMs: 0,
  pendingComponent: () => <LinksFrame loading />,
  preload: false,
  loader: async ({ context, abortController }) => {
    await whenUnlocked(abortController.signal);

    const latest = await context.walletClient.resolvePaymentLink();
    const links = await context.walletClient.paymentLinks();

    return { latest, links };
  },
  component: PaymentLinks,
});

type NoticeAction = Data.TaggedEnum<{
  Recover: { readonly link: SavedLinkTarget; readonly savedOnDevice: boolean };
  Recheck: {};
  Browse: {};
}>;

const NoticeAction = Data.taggedEnum<NoticeAction>();

class LatestNotice {
  constructor(
    readonly title: string,
    readonly message: string,
    readonly action: NoticeAction,
  ) {}
}

const latestNotice = (
  latest: ResolvePaymentLinkOutcome,
): Option.Option<LatestNotice> =>
  Match.valueTags(latest, {
    LatestPaymentLink: (resolved) =>
      Option.some(
        resolved.savedOnDevice
          ? new LatestNotice(
              "Tu último link sigue abierto",
              "Compártelo de nuevo o recupera el dinero mientras nadie lo use.",
              NoticeAction.Recover({ link: resolved, savedOnDevice: true }),
            )
          : new LatestNotice(
              "Tu último link ya no se puede compartir",
              lostLinkMessage,
              NoticeAction.Recover({ link: resolved, savedOnDevice: false }),
            ),
      ),
    Pending: () =>
      Option.some(
        new LatestNotice(
          "Tu último link aún se está creando",
          "Cuando termine, aparecerá aquí para compartirlo o recuperar el dinero.",
          NoticeAction.Recheck(),
        ),
      ),
    ApprovalOutstanding: () =>
      Option.some(
        new LatestNotice(
          "Tienes una operación en curso",
          "Cuando termine, tus links aparecerán aquí.",
          NoticeAction.Recheck(),
        ),
      ),
    PaymentLinkReceiptInvalid: () =>
      Option.some(
        new LatestNotice(
          "No pudimos confirmar tu último link",
          "Si aparece abajo, puedes recuperar el dinero.",
          NoticeAction.Browse(),
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
    SessionRequired: () => Option.none(),
    InvalidResponse: () => Option.none(),
  });

const listProblem = (
  links: Exclude<PaymentLinksOutcome, { _tag: "ListedPaymentLinks" }>,
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
    SessionRequired: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

const createdOn = (link: ListedPaymentLink, withSeconds: boolean) =>
  DateTime.toDate(link.createdAt).toLocaleString("es-PE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  });

const linkLabel = (link: ListedPaymentLink) =>
  `${amountLabel(link.amount, link.asset)} ${createdOn(link, false)}`;

const listedLinks = (links: ReadonlyArray<ListedPaymentLink>) =>
  links.map((link) => ({
    link,
    created: createdOn(
      link,
      links.some(
        (other) =>
          other.balance !== link.balance &&
          linkLabel(other) === linkLabel(link),
      ),
    ),
  }));

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
  const { started, begin, confirm, reset } = useRecovery();
  const sharing = useLinkReveal();

  if (Option.isSome(started))
    return (
      <LinksFrame>
        <RecoveryAnswer
          recovery={started.value}
          onBegin={begin}
          onConfirm={confirm}
          onCancel={reset}
          done={
            <ResultButton
              onClick={() =>
                void router.invalidate({ forcePending: true }).finally(reset)
              }
            >
              Listo
            </ResultButton>
          }
        />
      </LinksFrame>
    );

  return (
    <LinksFrame>
      {Predicate.isTagged(links, "ListedPaymentLinks") ? (
        <LinkList
          links={links.links}
          received={links.received}
          notice={latestNotice(latest)}
          onRecheck={() => void router.invalidate()}
          onChoose={begin}
          onShare={sharing.open}
        />
      ) : (
        <ListProblem message={listProblem(links)} />
      )}
      <LinkShareDrawer
        sharing={sharing}
        onRecover={(target) => begin(target)}
      />
    </LinksFrame>
  );
}

const receivedOn = (link: ReceivedPaymentLink) =>
  DateTime.toDate(link.receivedAt).toLocaleString("es-PE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

function ReceivedLinks({
  received,
}: {
  received: ReadonlyArray<ReceivedPaymentLink>;
}) {
  return received.length === 0 ? null : (
    <section
      aria-labelledby="received-links-title"
      className="flex flex-col gap-3"
    >
      <h2 id="received-links-title" className="text-label-lg">
        Links cobrados
      </h2>
      <div role="list" className="flex flex-col gap-3">
        {received.map((link) => (
          <Item
            key={link.id}
            variant="outline"
            role="listitem"
            data-testid="received-link"
            data-address={link.address}
          >
            <ItemContent>
              <ItemTitle className="whitespace-nowrap">
                {amountLabel(link.amount, link.asset)}
              </ItemTitle>
              <ItemDescription>
                Lo cobraron el {receivedOn(link)}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </div>
    </section>
  );
}

function LinkList({
  links,
  received,
  notice,
  onChoose,
  onShare,
  onRecheck,
}: {
  links: ReadonlyArray<ListedPaymentLink>;
  received: ReadonlyArray<ReceivedPaymentLink>;
  notice: Option.Option<LatestNotice>;
  onChoose: (link: RecoverableLink, created?: string) => void;
  onShare: (link: SavedLinkTarget) => void;
  onRecheck: () => void;
}) {
  const latest = Option.flatMap(notice, ({ action }) =>
    Predicate.isTagged(action, "Recover")
      ? Option.some(action.link)
      : Option.none(),
  );

  const listed = links.filter((link) =>
    Option.isNone(
      Option.filter(latest, (shown) => shown.balance === link.balance),
    ),
  );

  const rows = listedLinks(listed);

  return (
    <>
      <main
        data-testid="payment-links"
        className="flex flex-1 flex-col gap-6 px-5 pt-2"
      >
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
            {Match.valueTags(notice.value.action, {
              Recover: ({ link, savedOnDevice }) => (
                <>
                  {savedOnDevice ? (
                    <Button
                      className="w-full"
                      onClick={() => onShare(link)}
                      data-testid="reshare-latest-link"
                    >
                      Compartir link
                    </Button>
                  ) : null}
                  <Button
                    className="w-full"
                    variant={savedOnDevice ? "secondary" : "default"}
                    onClick={() => onChoose(link)}
                    data-testid="recover-latest-link"
                  >
                    Recuperar {amountLabel(link.amount, link.asset)}
                  </Button>
                </>
              ),
              Recheck: () => (
                <Button
                  className="w-full"
                  variant="secondary"
                  onClick={onRecheck}
                >
                  Revisar de nuevo
                </Button>
              ),
              Browse: () => null,
            })}
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
            {rows.map(({ link, created }) => (
              <Item key={link.balance} variant="outline" role="listitem">
                <ItemContent>
                  <ItemTitle className="whitespace-nowrap">
                    {amountLabel(link.amount, link.asset)}
                  </ItemTitle>
                  <ItemDescription>{created}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {link.savedOnDevice ? (
                    <Button
                      size="sm"
                      onClick={() => onShare(link)}
                      aria-label={`Compartir otra vez ${amountLabel(link.amount, link.asset)}, creado el ${created}`}
                      data-testid="reshare-link"
                    >
                      Compartir otra vez
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onChoose(link, created)}
                    aria-label={`Recuperar ${amountLabel(link.amount, link.asset)}, creado el ${created}`}
                    data-testid="recover-link"
                  >
                    Recuperar
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </div>
        )}
        <ReceivedLinks received={received} />
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
      <ScreenStatus title="No pudimos cargar tus links">
        <ScreenNote>{message}</ScreenNote>
      </ScreenStatus>
      <ScreenActions>
        <Button className="w-full" onClick={() => void router.invalidate()}>
          Reintentar
        </Button>
      </ScreenActions>
    </>
  );
}
