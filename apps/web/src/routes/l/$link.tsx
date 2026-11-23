import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  AccountAddress,
  type AssetStep,
  DraftRejected,
  type LinkReceiveReview,
  type PaymentLinkOpen,
  type WalletEnrolled,
  formatAmount,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { PasskeyBrowserGate } from "@/browser/passkey-browser-gate";
import {
  Screen,
  ScreenActions,
  ScreenNote,
  ScreenStatus,
} from "@/components/screen";
import { ExternalClaimFlow } from "@/links/external-claim-flow";
import {
  LinkResultScreen,
  LinkWorking,
  ResultButton,
  ResultLink,
} from "@/links/link-result";
import type { LinkScreen } from "@/links/outcomes";
import {
  type ReceiveAction,
  type ReceiveConclusion,
  receiveScreen,
} from "@/links/receive-outcomes";
import { AssetLine, FullValue } from "@/links/recovery";
import { amountLabel } from "@/send/money";
import { ReviewRow } from "@/send/payment-review";
import { DeviceFailure, useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";
import { enrollmentEffects } from "@/wallet/enrollment";
import { EnrollmentFlow } from "@/wallet/enrollment-flow";

export const Route = createFileRoute("/l/$link")({
  ssr: false,
  component: PaymentLinkPage,
});

type ReceiveStep = Data.TaggedEnum<{
  Reading: {};
  Offered: { readonly open: PaymentLinkOpen };
  ExternalClaiming: { readonly open: PaymentLinkOpen };
  Enrolling: { readonly open: PaymentLinkOpen };
  Preparing: { readonly open: PaymentLinkOpen };
  Reviewing: {
    readonly review: LinkReceiveReview;
    readonly problem: Option.Option<string>;
  };
  Confirming: { readonly review: LinkReceiveReview };
  Concluded: {
    readonly outcome: string;
    readonly screen: LinkScreen<ReceiveAction>;
  };
}>;

const ReceiveStep = Data.taggedEnum<ReceiveStep>();

const fragment = () => window.location.hash.slice(1);

const concluded = (outcome: ReceiveConclusion, received: string) =>
  ReceiveStep.Concluded({
    outcome: outcome._tag,
    screen: receiveScreen(outcome, received),
  });

const retriesReview = (answer: ReceiveConclusion) =>
  Predicate.isTagged(answer, "PasskeyCancelled") ||
  Predicate.isTagged(answer, "PasskeyFailed") ||
  Predicate.isTagged(answer, "WrongCredential") ||
  Predicate.isTagged(answer, "AssertionRejected");

function PaymentLinkPage() {
  const { link } = Route.useParams();

  const address = useMemo(
    () => Schema.decodeUnknownOption(AccountAddress)(link),
    [link],
  );

  return Option.match(address, {
    onNone: () => (
      <Screen>
        <ScreenStatus
          title="Este link no es válido"
          data-testid="link-outcome"
          data-outcome="InvalidAddress"
        >
          <ScreenNote>
            Ábrelo de nuevo desde el mensaje que te enviaron.
          </ScreenNote>
        </ScreenStatus>
      </Screen>
    ),
    onSome: (valid) => <ReceiveLink link={valid} />,
  });
}

function ReceiveLink({ link }: { link: AccountAddress }) {
  const { walletClient } = Route.useRouteContext();
  const task = useWalletTask();
  const [step, setStep] = useState<ReceiveStep>(ReceiveStep.Reading());

  const binding = useMemo(() => ({ link, fragment }), [link]);

  const read = () => {
    setStep(ReceiveStep.Reading());
    task.run(walletEffects.paymentLink(link, fragment()), (answer) =>
      setStep(
        Predicate.isTagged(answer, "PaymentLinkOpen")
          ? ReceiveStep.Offered({ open: answer })
          : concluded(answer, ""),
      ),
    );
  };

  useEffect(read, [link]);

  const review = (open: PaymentLinkOpen) => {
    const received = amountLabel(open.amount, open.asset);

    setStep(ReceiveStep.Preparing({ open }));
    task.run(walletEffects.reviewLinkReceive(link, fragment()), (answer) =>
      setStep(
        Predicate.isTagged(answer, "LinkReceiveReview")
          ? ReceiveStep.Reviewing({ review: answer, problem: Option.none() })
          : concluded(answer, received),
      ),
    );
  };

  const receive = (open: PaymentLinkOpen) => {
    task.run(
      Effect.all([walletEffects.saved(), enrollmentEffects.pending()]),
      (answer) => {
        if (answer instanceof DeviceFailure) {
          setStep(concluded(answer, ""));

          return;
        }

        const [saved, enrolling] = answer;

        if (Option.isSome(enrolling)) {
          setStep(ReceiveStep.Enrolling({ open }));

          return;
        }

        if (Predicate.isTagged(saved, "SavedWallet") && saved.openingApproved) {
          review(open);

          return;
        }

        setStep(
          Predicate.isTagged(saved, "SavedWallet") ||
            Predicate.isTagged(saved, "NoWallet")
            ? ReceiveStep.Enrolling({ open })
            : concluded(saved, ""),
        );
      },
    );
  };

  const confirm = (shown: LinkReceiveReview) => {
    const received = amountLabel(shown.amount, shown.asset);

    setStep(ReceiveStep.Confirming({ review: shown }));
    task.run(walletEffects.confirmLinkReceive(shown, fragment()), (answer) =>
      setStep(
        Predicate.isTagged(answer, "LinkReceiveReview")
          ? ReceiveStep.Reviewing({ review: answer, problem: Option.none() })
          : retriesReview(answer)
            ? ReceiveStep.Reviewing({
                review: shown,
                problem: Option.some(receiveScreen(answer, received).message),
              })
            : concluded(answer, received),
      ),
    );
  };

  const enrolled = (open: PaymentLinkOpen) => (outcome: WalletEnrolled) => {
    const received: AssetStep | undefined = outcome.received;

    if (received === undefined) {
      review(open);

      return;
    }

    setStep(
      concluded(
        Predicate.isTagged(received, "AssetDraft")
          ? new DraftRejected()
          : received,
        amountLabel(open.amount, open.asset),
      ),
    );
  };

  return Match.valueTags(step, {
    Reading: () => (
      <Screen>
        <LinkWorking label="Revisando el link…" />
      </Screen>
    ),
    Offered: ({ open }) => (
      <Screen>
        <ScreenStatus
          title={amountLabel(open.amount, open.asset)}
          data-testid="link-offer"
        >
          <ScreenNote>
            @{open.sender.username} te envió este dinero con un link de Orchid.
          </ScreenNote>
        </ScreenStatus>
        <ScreenActions>
          <Button
            className="w-full"
            data-testid="receive-link"
            onClick={() => receive(open)}
          >
            Recibir en mi Orchid
          </Button>
          <Button
            className="w-full"
            variant="secondary"
            data-testid="claim-external"
            onClick={() => setStep(ReceiveStep.ExternalClaiming({ open }))}
          >
            Enviar a otra dirección
          </Button>
        </ScreenActions>
      </Screen>
    ),
    ExternalClaiming: ({ open }) => (
      <ExternalClaimFlow
        link={link}
        open={open}
        fragment={fragment}
        onBack={() => setStep(ReceiveStep.Offered({ open }))}
        onRecheck={read}
      />
    ),
    Enrolling: ({ open }) => (
      <PasskeyBrowserGate>
        <EnrollmentFlow
          title="Recibe tu dinero"
          back={(disabled) => (
            <a
              href={`/l/${link}`}
              aria-disabled={disabled}
              onClick={(event) => {
                event.preventDefault();

                if (!disabled) setStep(ReceiveStep.Offered({ open }));
              }}
            />
          )}
          walletClient={walletClient}
          receive={binding}
          onEnrolled={enrolled(open)}
          onOpened={() => review(open)}
        />
      </PasskeyBrowserGate>
    ),
    Preparing: () => (
      <Screen>
        <LinkWorking label="Preparando tu cobro…" />
      </Screen>
    ),
    Reviewing: ({ review: shown, problem }) => (
      <Screen>
        <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
          <h1 className="font-display text-h1">Revisa tu cobro</h1>
          <dl
            aria-label="Resumen del cobro"
            data-testid="receive-review"
            className="flex flex-col divide-y divide-border rounded-lg border border-border px-4"
          >
            <ReviewRow label="De">@{shown.sender.username}</ReviewRow>
            <ReviewRow label="Activo">
              <AssetLine asset={shown.asset} />
            </ReviewRow>
            <ReviewRow label="Monto">{formatAmount(shown.amount)}</ReviewRow>
            <ReviewRow label="Para">
              <FullValue>{shown.order.wallet}</FullValue>
            </ReviewRow>
            <ReviewRow label="Red">Stellar {shown.network}</ReviewRow>
            <ReviewRow label="Comisión">Orchid paga la comisión</ReviewRow>
          </dl>
          <p className="text-body text-muted-foreground">
            El dinero del link pasará a tu cuenta y el link dejará de funcionar.
            Tu passkey confirma que eres tú, pero no muestra los datos de la
            operación. Revísalos aquí antes de confirmar.
          </p>
          {Option.isSome(problem) ? (
            <p role="alert" className="text-body text-destructive">
              {problem.value}
            </p>
          ) : null}
        </main>
        <ScreenActions>
          <Button
            className="w-full"
            data-testid="confirm-receive"
            onClick={() => confirm(shown)}
          >
            Recibir con passkey
          </Button>
        </ScreenActions>
      </Screen>
    ),
    Confirming: () => (
      <Screen>
        <LinkWorking label="Recibiendo tu dinero…" />
      </Screen>
    ),
    Concluded: ({ outcome, screen }) => (
      <Screen>
        <LinkResultScreen outcome={outcome} screen={screen}>
          {Match.value(screen.action).pipe(
            Match.when("home", () => (
              <ResultLink link={<Link to="/home" />}>Ir a mi cuenta</ResultLink>
            )),
            Match.when("again", () => (
              <ResultButton onClick={read}>Reintentar</ResultButton>
            )),
            Match.when("check", () => (
              <ResultButton onClick={read}>Revisar de nuevo</ResultButton>
            )),
            Match.when("done", () => (
              <ResultLink link={<Link to="/" />}>Ir al inicio</ResultLink>
            )),
            Match.exhaustive,
          )}
        </LinkResultScreen>
      </Screen>
    ),
  });
}
