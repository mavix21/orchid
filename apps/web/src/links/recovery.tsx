import { useReducer } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";

import {
  type Asset,
  type ConfirmReclaimOutcome,
  type ReclaimReview,
  type ReviewReclaimOutcome,
  formatAmount,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ScreenActions } from "@/components/screen";
import { assetCode } from "@/send/money";
import { ReviewRow } from "@/send/payment-review";
import { type Answer, useWalletTask } from "@/send/use-wallet-task";
import { walletEffects } from "@/wallet";

import {
  LinkResultScreen,
  LinkWorking,
  ResultButton,
  ResultLink,
} from "./link-result";
import {
  type ReclaimConclusion,
  type RecoverableLink,
  reclaimResult,
} from "./outcomes";

interface ChosenLink {
  readonly link: RecoverableLink;
  readonly created: Option.Option<string>;
}

type Recovery = Data.TaggedEnum<{
  Idle: {};
  Reviewing: { readonly chosen: ChosenLink };
  Reviewed: {
    readonly chosen: ChosenLink;
    readonly review: ReclaimReview;
    readonly problem: Option.Option<string>;
  };
  Confirming: { readonly chosen: ChosenLink; readonly review: ReclaimReview };
  Recovered: {
    readonly chosen: ChosenLink;
    readonly answer: Answer<ReclaimConclusion>;
  };
}>;

const Recovery = Data.taggedEnum<Recovery>();

export type RecoveryStarted = Exclude<
  Recovery,
  Data.TaggedEnum.Value<Recovery, "Idle">
>;

type RecoveryEvent = Data.TaggedEnum<{
  ReviewStarted: { readonly chosen: ChosenLink };
  ReviewAnswered: { readonly answer: Answer<ReviewReclaimOutcome> };
  ConfirmStarted: {};
  ConfirmAnswered: { readonly answer: Answer<ConfirmReclaimOutcome> };
  Reset: {};
}>;

const RecoveryEvent = Data.taggedEnum<RecoveryEvent>();

const expired =
  "La recuperación anterior venció y la preparamos de nuevo. Revísala y confirma otra vez.";

const confirmed = (
  state: Data.TaggedEnum.Value<Recovery, "Confirming">,
  answer: Answer<ConfirmReclaimOutcome>,
): Recovery => {
  const withdrawn = (problem: string) =>
    Recovery.Reviewed({
      chosen: state.chosen,
      review: state.review,
      problem: Option.some(problem),
    });

  return Match.value(answer).pipe(
    Match.tag("ReclaimReview", (review) =>
      Recovery.Reviewed({
        chosen: state.chosen,
        review,
        problem: Option.some(expired),
      }),
    ),
    Match.tag("PasskeyCancelled", () =>
      withdrawn("No usaste tu passkey, así que no recuperamos el dinero."),
    ),
    Match.tag("PasskeyFailed", () =>
      withdrawn(
        "No pudimos usar tu passkey y no recuperamos el dinero. Inténtalo de nuevo.",
      ),
    ),
    Match.tag("WrongCredential", () =>
      withdrawn(
        "Usaste una passkey distinta y no recuperamos el dinero. Confirma con la passkey de tu cuenta.",
      ),
    ),
    Match.tag("AssertionRejected", () =>
      withdrawn(
        "No pudimos verificar tu passkey y no recuperamos el dinero. Confirma con tu huella, rostro o PIN del dispositivo.",
      ),
    ),
    Match.orElse((outcome) =>
      Recovery.Recovered({ chosen: state.chosen, answer: outcome }),
    ),
  );
};

const reduceRecovery = (state: Recovery, event: RecoveryEvent): Recovery =>
  Match.valueTags(event, {
    ReviewStarted: ({ chosen }) => Recovery.Reviewing({ chosen }),
    ReviewAnswered: ({ answer }) =>
      Predicate.isTagged(state, "Reviewing")
        ? Predicate.isTagged(answer, "ReclaimReview")
          ? Recovery.Reviewed({
              chosen: state.chosen,
              review: answer,
              problem: Option.none(),
            })
          : Recovery.Recovered({ chosen: state.chosen, answer })
        : state,
    ConfirmStarted: () =>
      Predicate.isTagged(state, "Reviewed")
        ? Recovery.Confirming({ chosen: state.chosen, review: state.review })
        : state,
    ConfirmAnswered: ({ answer }) =>
      Predicate.isTagged(state, "Confirming")
        ? confirmed(state, answer)
        : state,
    Reset: () => Recovery.Idle(),
  });

export function useRecovery() {
  const task = useWalletTask();
  const [recovery, send] = useReducer(reduceRecovery, Recovery.Idle());

  const begin = (link: RecoverableLink, created?: string) => {
    send(
      RecoveryEvent.ReviewStarted({
        chosen: { link, created: Option.fromNullishOr(created) },
      }),
    );
    task.run(walletEffects.reviewReclaim(link), (answer) =>
      send(RecoveryEvent.ReviewAnswered({ answer })),
    );
  };

  const confirm = () => {
    if (!Predicate.isTagged(recovery, "Reviewed")) return;

    send(RecoveryEvent.ConfirmStarted());
    task.run(walletEffects.confirmReclaim(recovery.review), (answer) =>
      send(RecoveryEvent.ConfirmAnswered({ answer })),
    );
  };

  const reset = () => {
    task.stop();
    send(RecoveryEvent.Reset());
  };

  const started = Match.valueTags(recovery, {
    Idle: () => Option.none<RecoveryStarted>(),
    Reviewing: (shown) => Option.some<RecoveryStarted>(shown),
    Reviewed: (shown) => Option.some<RecoveryStarted>(shown),
    Confirming: (shown) => Option.some<RecoveryStarted>(shown),
    Recovered: (shown) => Option.some<RecoveryStarted>(shown),
  });

  return { started, begin, confirm, reset };
}

export function FullValue({ children }: { children: string }) {
  return <span className="font-mono text-caption break-all">{children}</span>;
}

export function AssetLine({ asset }: { asset: Asset }) {
  return (
    <span className="flex flex-col items-end">
      <span>{assetCode(asset)}</span>
      {Predicate.isTagged(asset, "Issued") ? (
        <FullValue>{asset.issuer}</FullValue>
      ) : null}
    </span>
  );
}

function ReclaimReviewScreen({
  chosen,
  review,
  problem,
  onConfirm,
  onCancel,
}: {
  chosen: ChosenLink;
  review: ReclaimReview;
  problem: Option.Option<string>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">Revisa tu recuperación</h1>
        <dl
          aria-label="Resumen de la recuperación"
          className="flex flex-col divide-y divide-border rounded-lg border border-border px-4"
        >
          <ReviewRow label="Acción">Recuperar el dinero de un link</ReviewRow>
          <ReviewRow label="Activo">
            <AssetLine asset={review.asset} />
          </ReviewRow>
          <ReviewRow label="Monto">{formatAmount(review.amount)}</ReviewRow>
          <ReviewRow label="Link">
            <span className="flex flex-col items-end">
              <FullValue>{review.balance}</FullValue>
              {Option.isSome(chosen.created) ? (
                <span className="text-caption text-muted-foreground">
                  Creado el {chosen.created.value}
                </span>
              ) : null}
            </span>
          </ReviewRow>
          <ReviewRow label="Cuenta">
            <FullValue>{review.order.wallet}</FullValue>
          </ReviewRow>
          <ReviewRow label="Red">Stellar {review.network}</ReviewRow>
          {review.opensTrustline === undefined ? null : (
            <ReviewRow label="Moneda nueva">
              <span className="flex flex-col items-end">
                <AssetLine asset={review.opensTrustline} />
                <span className="text-caption text-muted-foreground">
                  Se activa en tu cuenta para recibirla
                </span>
              </span>
            </ReviewRow>
          )}
          <ReviewRow label="Comisión">Orchid paga la comisión</ReviewRow>
        </dl>
        <p className="text-body text-muted-foreground">
          El link dejará de funcionar. Si nadie lo usó, el dinero vuelve a tu
          cuenta. Tu passkey confirma que eres tú, pero no muestra los datos de
          la operación. Revísalos aquí antes de confirmar.
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
          onClick={onConfirm}
          data-testid="confirm-recover"
        >
          Recuperar dinero
        </Button>
        <Button className="w-full" variant="secondary" onClick={onCancel}>
          Mantener el link
        </Button>
      </ScreenActions>
    </>
  );
}

export function RecoveryAnswer({
  recovery,
  done,
  onBegin,
  onConfirm,
  onCancel,
}: {
  recovery: RecoveryStarted;
  done: React.ReactNode;
  onBegin: (link: RecoverableLink, created?: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return Match.valueTags(recovery, {
    Reviewing: () => <LinkWorking label="Preparando tu recuperación…" />,
    Confirming: () => <LinkWorking label="Recuperando tu dinero…" />,
    Reviewed: ({ chosen, review, problem }) => (
      <ReclaimReviewScreen
        chosen={chosen}
        review={review}
        problem={problem}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    ),
    Recovered: ({ chosen, answer }) => {
      const screen = reclaimResult(answer, chosen.link);

      const again = () =>
        onBegin(chosen.link, Option.getOrUndefined(chosen.created));

      return (
        <LinkResultScreen outcome={answer._tag} screen={screen}>
          {Match.value(screen.action).pipe(
            Match.when("done", () => done),
            Match.when("home", () => (
              <ResultLink link={<Link to="/home" />}>
                Volver al inicio
              </ResultLink>
            )),
            Match.when("again", () => (
              <ResultButton onClick={again}>Reintentar</ResultButton>
            )),
            Match.when("check", () => (
              <ResultButton onClick={again}>Revisar de nuevo</ResultButton>
            )),
            Match.exhaustive,
          )}
        </LinkResultScreen>
      );
    },
  });
}
