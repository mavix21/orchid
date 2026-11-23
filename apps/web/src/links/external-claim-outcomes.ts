import type {
  Asset,
  ConfirmExternalLinkOutcome,
  DestinationAddress,
  ExternalLinkReview,
  WalletUnavailable,
} from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";

import { LinkScreen } from "@/links/outcomes";
import { assetCode, shortAddress } from "@/send/money";
import type { DeviceFailure } from "@/send/use-wallet-task";
import { unavailableMessage } from "@/wallet/unavailable";

import { ExternalClaimFieldProblem } from "./external-claim-intent";

export type ExternalClaimAction = "check" | "done";

export type ExternalClaimConclusion =
  | Exclude<ConfirmExternalLinkOutcome, ExternalLinkReview>
  | DeviceFailure;

export type ExternalClaimResult = Data.TaggedEnum<{
  Field: { readonly problem: ExternalClaimFieldProblem };
  RetryLookup: { readonly message: string };
  Concluded: {
    readonly outcome: string;
    readonly screen: LinkScreen<ExternalClaimAction>;
  };
}>;

export const ExternalClaimResult = Data.taggedEnum<ExternalClaimResult>();

const stillInLink = "El dinero sigue en el link.";

const lookupFailedMessage =
  "No pudimos verificar los datos del depósito. El dinero sigue en el link.";

const used = new LinkScreen<ExternalClaimAction>(
  "Este link ya fue usado",
  "Ya no tiene dinero para recibir.",
  "done",
);

const unresolved = new LinkScreen<ExternalClaimAction>(
  "No pudimos confirmar qué pasó con este link",
  "Ya no tiene dinero, pero no podemos saber quién lo recibió.",
  "done",
);

const checking = new LinkScreen<ExternalClaimAction>(
  "Estamos comprobando si se envió",
  "Revisa de nuevo en un momento.",
  "check",
);

const notSent = (message: string, action: ExternalClaimAction = "check") =>
  new LinkScreen<ExternalClaimAction>(
    "No pudimos enviar este dinero",
    message,
    action,
  );

const concluded = (
  outcome: ExternalClaimConclusion,
  screen: LinkScreen<ExternalClaimAction>,
) => ExternalClaimResult.Concluded({ outcome: outcome._tag, screen });

const fieldProblem = (field: "destination" | "memo", message: string) =>
  ExternalClaimResult.Field({
    problem: new ExternalClaimFieldProblem(field, message),
  });

const mapResult = (
  outcome: ExternalClaimConclusion,
  asset: Asset,
  mode:
    | { readonly kind: "review" }
    | {
        readonly kind: "confirm";
        readonly sent: string;
        readonly destination: DestinationAddress;
      },
): ExternalClaimResult => {
  const code = assetCode(asset);

  const onUnavailable = (failure: WalletUnavailable) =>
    mode.kind === "review"
      ? ExternalClaimResult.RetryLookup({ message: lookupFailedMessage })
      : concluded(
          outcome,
          notSent(`${unavailableMessage(failure)} ${stillInLink}`, "check"),
        );

  return Match.valueTags(outcome, {
    ExternalLinkSettled: () =>
      concluded(
        outcome,
        new LinkScreen<ExternalClaimAction>(
          "Enviado",
          mode.kind === "confirm"
            ? `Enviamos ${mode.sent} a ${shortAddress(mode.destination)}.`
            : "Enviamos el dinero del link a esa dirección.",
          "done",
        ),
      ),
    ExternalLinkPending: () => concluded(outcome, checking),
    PaymentLinkChecking: () => concluded(outcome, checking),
    ExternalLinkFailed: () =>
      concluded(
        outcome,
        notSent(
          "La operación no se completó. Revisa el link para saber si el dinero sigue ahí.",
          "check",
        ),
      ),
    BalanceGone: ({ status }) =>
      concluded(outcome, status === "unresolved" ? unresolved : used),
    PaymentLinkUsed: () => concluded(outcome, used),
    PaymentLinkUnresolved: () => concluded(outcome, unresolved),
    PaymentLinkNotFound: () =>
      concluded(
        outcome,
        new LinkScreen<ExternalClaimAction>(
          "No encontramos este link",
          "Revisa que lo hayas abierto completo desde el mensaje que te enviaron.",
          "done",
        ),
      ),
    LinkSecretMismatch: () =>
      concluded(
        outcome,
        new LinkScreen<ExternalClaimAction>(
          "Este link está incompleto",
          "Ábrelo de nuevo desde el mensaje que te enviaron.",
          "done",
        ),
      ),
    InvalidAddress: () =>
      fieldProblem("destination", "La dirección no es válida"),
    ExternalMemoRequired: () =>
      fieldProblem(
        "memo",
        "Esta dirección requiere un memo. Cópialo de la pantalla de depósito.",
      ),
    MemoNotAllowed: () =>
      fieldProblem(
        "memo",
        "Esta dirección ya identifica tu cuenta; no necesita memo.",
      ),
    RecipientCannotReceive: ({ reason }) =>
      fieldProblem(
        "destination",
        Match.value(reason).pipe(
          Match.when("no_account", () => "Esa cuenta no existe en Stellar."),
          Match.when(
            "no_trustline",
            () => `Esa cuenta no acepta ${code} todavía.`,
          ),
          Match.when(
            "not_authorized",
            () => `El emisor de ${code} no autoriza esa cuenta.`,
          ),
          Match.when(
            "no_capacity",
            () => `Esa cuenta no puede recibir tanto ${code} por ahora.`,
          ),
          Match.exhaustive,
        ),
      ),
    LinkUnclaimable: ({ reason }) =>
      Match.value(reason).pipe(
        Match.when("destination_is_link", () =>
          fieldProblem(
            "destination",
            "No puedes enviar el dinero a la misma dirección del link.",
          ),
        ),
        Match.when("destination_is_issuer", () =>
          fieldProblem(
            "destination",
            `No puedes enviar ${code} a la dirección que la emite.`,
          ),
        ),
        Match.when("link_account_exists", () =>
          concluded(
            outcome,
            new LinkScreen<ExternalClaimAction>(
              "No pudimos cobrar este link",
              "El dinero sigue disponible para quien lo envió.",
              "done",
            ),
          ),
        ),
        Match.exhaustive,
      ),
    NotClaimable: () =>
      concluded(outcome, notSent(`Inténtalo de nuevo. ${stillInLink}`)),
    DraftRejected: () =>
      concluded(
        outcome,
        notSent(`La solicitud cambió antes de firmarse. ${stillInLink}`),
      ),
    DeviceFailure: () =>
      mode.kind === "review"
        ? ExternalClaimResult.RetryLookup({ message: lookupFailedMessage })
        : concluded(
            outcome,
            notSent(`Algo falló en este dispositivo. ${stillInLink}`, "check"),
          ),
    Offline: onUnavailable,
    ServerUnreachable: onUnavailable,
    LedgerUnreachable: onUnavailable,
    ServiceFailed: onUnavailable,
    InvalidResponse: onUnavailable,
  });
};

export const reviewExternalResult = (
  outcome: ExternalClaimConclusion,
  asset: Asset,
) => mapResult(outcome, asset, { kind: "review" });

export const confirmExternalResult = (
  outcome: ExternalClaimConclusion,
  asset: Asset,
  sent: string,
  destination: DestinationAddress,
) => mapResult(outcome, asset, { kind: "confirm", sent, destination });
