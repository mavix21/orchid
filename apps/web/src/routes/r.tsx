import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  type AssetStep,
  DraftRejected,
  type LinkReceiveReview,
  type PaymentLinkOpen,
  type ReadLinkCode,
  type WalletEnrolled,
  readLinkCode,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { PasskeyBrowserGate } from "@/browser/passkey-browser-gate";
import { BrandLogo } from "@/components/brand-logo";
import { BloomActions, BloomHero } from "@/components/orchid-bloom";
import { Screen, ScreenNote, ScreenStatus } from "@/components/screen";
import { ExternalClaimFlow } from "@/links/external-claim-flow";
import {
  LinkResultScreen,
  ResultButton,
  ResultLink,
} from "@/links/link-result";
import type { LinkScreen } from "@/links/outcomes";
import {
  type ReceiveAction,
  type ReceiveConclusion,
  receiveScreen,
} from "@/links/receive-outcomes";
import { amountLabel } from "@/send/money";
import { DeviceFailure, useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";
import { enrollmentEffects } from "@/wallet/enrollment";
import { EnrollmentFlow } from "@/wallet/enrollment-flow";

const publicOrigin = createIsomorphicFn()
  .server(() => getRequestUrl().origin)
  .client(() => window.location.origin);

const previewTitle = "Link de pago de Orchid";
const previewDescription = "Ábrelo para ver el pago y recibirlo en Orchid.";

export const Route = createFileRoute("/r")({
  ssr: false,
  head: () => {
    const origin = publicOrigin();

    return {
      meta: [
        { title: previewTitle },
        { name: "description", content: previewDescription },
        { name: "robots", content: "noindex, nofollow" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Orchid" },
        { property: "og:title", content: previewTitle },
        { property: "og:description", content: previewDescription },
        { property: "og:url", content: `${origin}/r` },
        { property: "og:image", content: `${origin}/og-payment-link.png` },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
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
    readonly received: string;
  };
}>;

const ReceiveStep = Data.taggedEnum<ReceiveStep>();

const subscribeToLocation = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);

  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
};

const readFragment = () => window.location.hash.slice(1);

const noFragmentOnServer = () => "";

const concluded = (outcome: ReceiveConclusion, received: string) =>
  ReceiveStep.Concluded({
    outcome: outcome._tag,
    screen: receiveScreen(outcome, received),
    received,
  });

const retriesReview = (answer: ReceiveConclusion) =>
  Predicate.isTagged(answer, "PasskeyCancelled") ||
  Predicate.isTagged(answer, "PasskeyFailed") ||
  Predicate.isTagged(answer, "WrongCredential") ||
  Predicate.isTagged(answer, "AssertionRejected");

function PaymentLinkPage() {
  const fragment = useSyncExternalStore(
    subscribeToLocation,
    readFragment,
    noFragmentOnServer,
  );

  const opened = useMemo(() => readLinkCode(fragment), [fragment]);

  return Option.match(opened, {
    onNone: () => (
      <Screen>
        <ScreenStatus
          title={
            fragment === ""
              ? "Falta parte del link"
              : "Este link está incompleto"
          }
          data-testid="link-outcome"
          data-outcome={fragment === "" ? "LinkCodeMissing" : "LinkCodeInvalid"}
        >
          <ScreenNote>
            Copia el link completo del mensaje que te enviaron y ábrelo de
            nuevo.
          </ScreenNote>
        </ScreenStatus>
      </Screen>
    ),
    onSome: (valid) => <ReceiveLink key={valid.code} opened={valid} />,
  });
}

const stepForAnotherLink = (received: AssetStep, opened: ReadLinkCode) =>
  "action" in received &&
  !(
    Predicate.isTagged(received.action, "ReceiveLink") &&
    received.action.link === opened.link
  );

function ReceiveLink({ opened }: { opened: ReadLinkCode }) {
  const { walletClient } = Route.useRouteContext();
  const task = useWalletTask();
  const [step, setStep] = useState<ReceiveStep>(ReceiveStep.Reading());
  const { code } = opened;

  const read = () => {
    setStep(ReceiveStep.Reading());
    task.run(walletEffects.paymentLink(code), (answer) =>
      setStep(
        Predicate.isTagged(answer, "PaymentLinkOpen")
          ? ReceiveStep.Offered({ open: answer })
          : concluded(answer, ""),
      ),
    );
  };

  useEffect(read, []);

  const review = (open: PaymentLinkOpen) => {
    const received = amountLabel(open.amount, open.asset);

    setStep(ReceiveStep.Preparing({ open }));
    task.run(walletEffects.reviewLinkReceive(code), (answer) =>
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
    task.run(walletEffects.confirmLinkReceive(shown, code), (answer) =>
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

    if (stepForAnotherLink(received, opened)) {
      read();

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
        <p role="status" className="sr-only">
          Revisando el link…
        </p>
      </Screen>
    ),
    Offered: ({ open }) => (
      <Screen>
        <ClaimHeader />
        <main data-testid="link-offer" className="flex flex-1 flex-col px-5">
          <BloomHero
            motion="bloom"
            label={`@${open.sender.username} te envió`}
            amount={amountLabel(open.amount, open.asset)}
          />
        </main>
        <BloomActions>
          <Button
            className="w-full"
            data-testid="receive-link"
            onClick={() => receive(open)}
          >
            Recibir en Orchid
          </Button>
          <Button
            className="w-full"
            variant="secondary"
            data-testid="claim-external"
            onClick={() => setStep(ReceiveStep.ExternalClaiming({ open }))}
          >
            Enviar a otra dirección
          </Button>
        </BloomActions>
      </Screen>
    ),
    ExternalClaiming: ({ open }) => (
      <ExternalClaimFlow
        code={code}
        open={open}
        onBack={() => setStep(ReceiveStep.Offered({ open }))}
        onRecheck={read}
      />
    ),
    Enrolling: ({ open }) => (
      <PasskeyBrowserGate>
        <EnrollmentFlow
          title="Recibe tu dinero"
          back={() => ({
            onClick: () => setStep(ReceiveStep.Offered({ open })),
          })}
          walletClient={walletClient}
          receive={opened}
          onEnrolled={enrolled(open)}
          onOpened={() => review(open)}
        />
      </PasskeyBrowserGate>
    ),
    Preparing: ({ open }) => (
      <ReceiveReview
        sender={open.sender.username}
        amount={amountLabel(open.amount, open.asset)}
        testnet={false}
        problem={Option.none()}
      />
    ),
    Reviewing: ({ review: shown, problem }) => (
      <ReceiveReview
        sender={shown.sender.username}
        amount={amountLabel(shown.amount, shown.asset)}
        testnet={shown.network === "testnet"}
        problem={problem}
        onConfirm={() => confirm(shown)}
      />
    ),
    Confirming: ({ review: shown }) => (
      <Screen>
        <ClaimHeader />
        <main role="status" className="flex flex-1 flex-col px-5">
          <BloomHero
            motion="breathe"
            label="Recibiendo tu dinero…"
            amount={amountLabel(shown.amount, shown.asset)}
          />
        </main>
        <BloomActions />
      </Screen>
    ),
    Concluded: ({ outcome, screen, received }) =>
      outcome === "AssetSettled" ? (
        <Screen>
          <ClaimHeader />
          <main
            data-testid="link-outcome"
            data-outcome={outcome}
            className="flex flex-1 flex-col px-5"
          >
            <BloomHero motion="flourish" label="Recibiste" amount={received}>
              <p className="text-body text-muted-foreground">
                {screen.message}
              </p>
            </BloomHero>
          </main>
          <BloomActions>
            <ResultLink link={<Link to="/home" />}>Ir a mi cuenta</ResultLink>
          </BloomActions>
        </Screen>
      ) : (
        <Screen>
          <LinkResultScreen outcome={outcome} screen={screen}>
            {Match.value(screen.action).pipe(
              Match.when("home", () => (
                <ResultLink link={<Link to="/home" />}>
                  Ir a mi cuenta
                </ResultLink>
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

function ReceiveReview({
  sender,
  amount,
  testnet,
  problem,
  onConfirm,
}: {
  sender: string;
  amount: string;
  testnet: boolean;
  problem: Option.Option<string>;
  onConfirm?: () => void;
}) {
  const ready = onConfirm !== undefined;

  return (
    <Screen>
      <ClaimHeader />
      <main
        data-testid={ready ? "receive-review" : undefined}
        aria-busy={!ready}
        className="flex flex-1 flex-col px-5"
      >
        <BloomHero motion="rest" label={`De @${sender}`} amount={amount}>
          <div className="flex h-6 items-center">
            {testnet ? <Badge variant="neutral">Testnet</Badge> : null}
          </div>
          <p className="text-body text-pretty text-muted-foreground">
            El dinero pasa a tu cuenta y el link deja de funcionar.
          </p>
          {Option.isSome(problem) ? (
            <p role="alert" className="text-body text-destructive">
              {problem.value}
            </p>
          ) : null}
        </BloomHero>
      </main>
      <BloomActions>
        <Button
          className="w-full"
          data-testid={ready ? "confirm-receive" : undefined}
          disabled={!ready}
          onClick={onConfirm}
        >
          Recibir con passkey
        </Button>
      </BloomActions>
    </Screen>
  );
}

function ClaimHeader() {
  return (
    <header className="flex h-14 items-center justify-center px-5">
      <BrandLogo />
    </header>
  );
}
