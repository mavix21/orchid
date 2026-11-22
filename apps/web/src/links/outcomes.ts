import type {
  Asset,
  CancelPaymentLinkOutcome,
  CreatePaymentLinkOutcome,
  PaymentLinkCreated,
  PaymentLinkTarget,
  PositiveAmount,
  ResolvePaymentLinkOutcome,
  ResolvedPaymentLink,
  WalletUnavailable,
} from "@workspace/wallet";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { amountLabel, assetCode } from "@/send/money";
import { unavailableMessage } from "@/wallet/unavailable";

export type LinkAction =
  | "done"
  | "home"
  | "again"
  | "edit"
  | "check"
  | "links"
  | "assets"
  | "elsewhere";

export class LinkScreen {
  constructor(
    readonly title: string,
    readonly message: string,
    readonly action: LinkAction,
  ) {}
}

export interface RecoverableLink extends PaymentLinkTarget {
  readonly amount: PositiveAmount;
}

export const lostLinkMessage =
  "Por seguridad, un link solo se puede compartir justo después de crearlo. Tu dinero sigue a salvo: recupéralo y crea uno nuevo.";

const untouched = "Tu dinero no se movió.";

const checkFirst = "Revisa si tu link se creó antes de crear otro.";

const stillInLink = "El dinero sigue en el link.";

const unavailableTitle = (failure: WalletUnavailable) =>
  Match.valueTags(failure, {
    Offline: () => "Sin conexión",
    ServerUnreachable: () => "No pudimos conectar con Orchid",
    LedgerUnreachable: () => "La red Stellar no responde",
    ServiceFailed: () => "Algo falló de nuestro lado",
    InvalidResponse: () => "No pudimos leer la respuesta",
  });

const unavailable = (failure: WalletUnavailable, next: string) =>
  new LinkScreen(
    unavailableTitle(failure),
    `${unavailableMessage(failure)} ${next}`,
    "check",
  );

export const creationDeviceFailure = new LinkScreen(
  "Algo falló en este dispositivo",
  checkFirst,
  "check",
);

export const recoveryDeviceFailure = new LinkScreen(
  "Algo falló en este dispositivo",
  "Revisa de nuevo para saber si recuperaste el dinero.",
  "check",
);

const notByLink = "Esta moneda no se puede enviar con un link de pago.";

const unsupportedScreen = (
  reason:
    | "issuer_missing"
    | "self_issued"
    | "base_asset"
    | "authorization_required"
    | "clawback_enabled",
  code: string,
) =>
  reason === "clawback_enabled"
    ? new LinkScreen(
        `No puedes enviar ${code} con un link`,
        `${notByLink} Puedes enviarla a un @usuario o a una dirección, o elegir otra moneda. ${untouched}`,
        "elsewhere",
      )
    : new LinkScreen(
        `No puedes enviar ${code} con un link`,
        `${notByLink} Elige otra moneda. ${untouched}`,
        "assets",
      );

const stillCreating = new LinkScreen(
  "Tu link aún se está creando",
  "Este link ya no se podrá compartir. Cuando termine de crearse, recupera el dinero y crea uno nuevo.",
  "check",
);

const busyCreating = new LinkScreen(
  "Espera un momento",
  "Tienes otra operación en curso. Espera su resultado antes de crear un link.",
  "again",
);

const busyRecovering = new LinkScreen(
  "Espera un momento",
  "Tienes una operación en curso. Espera su resultado y revisa de nuevo.",
  "check",
);

const notCreated = new LinkScreen(
  "No se creó el link",
  `Algo no cuadró al preparar tu link. ${untouched}`,
  "home",
);

export const createLinkResult = (
  outcome: Exclude<CreatePaymentLinkOutcome, PaymentLinkCreated>,
  asset: Asset,
): LinkScreen =>
  Match.valueTags(outcome, {
    Pending: () => stillCreating,
    ApprovalOutstanding: ({ order }) =>
      Predicate.isTagged(order.to, "PaymentLink")
        ? new LinkScreen(
            "Tu último link aún se está creando",
            "Espera a que termine antes de crear otro.",
            "check",
          )
        : new LinkScreen(
            "Tienes un pago en curso",
            "Espera su resultado antes de crear un link.",
            "again",
          ),
    DraftRejected: () =>
      new LinkScreen("No pudimos confirmar tu link", checkFirst, "check"),
    Failed: ({ reason }) =>
      new LinkScreen(
        "No se creó el link",
        reason === "expired"
          ? `No se confirmó a tiempo. ${untouched}`
          : `La red rechazó el link. ${untouched}`,
        "again",
      ),
    InsufficientBalance: ({ available }) =>
      new LinkScreen(
        `No tienes suficiente ${assetCode(asset)}`,
        `Tienes ${amountLabel(available, asset)} disponibles. ${untouched}`,
        "edit",
      ),
    ClaimableLimitReached: ({ limit }) =>
      new LinkScreen(
        `Ya tienes ${limit} links abiertos`,
        `Puedes tener hasta ${limit} a la vez. Recupera el dinero de uno para crear otro. ${untouched}`,
        "links",
      ),
    AssetUnsupported: ({ reason }) =>
      unsupportedScreen(reason, assetCode(asset)),
    SenderBusy: () => busyCreating,
    AssetBusy: () => busyCreating,
    NotOpened: () =>
      new LinkScreen(
        "Aún no puedes crear links",
        "Tu cuenta aún se está activando.",
        "home",
      ),
    InvalidAddress: () => notCreated,
    UnknownRecipient: () => notCreated,
    PhoneNotSupported: () => notCreated,
    ExternalMemoRequired: () => notCreated,
    MemoNotAllowed: () => notCreated,
    RecipientCannotReceive: () => notCreated,
    NoWallet: () =>
      new LinkScreen(
        "No hay una cuenta aquí",
        "Este dispositivo no tiene una cuenta de Orchid.",
        "home",
      ),
    UnsupportedDevice: () =>
      new LinkScreen(
        "No pudimos leer tu llave",
        "Este navegador no puede leer tu llave de forma segura.",
        "home",
      ),
    Offline: (failure) => unavailable(failure, checkFirst),
    ServerUnreachable: (failure) => unavailable(failure, checkFirst),
    LedgerUnreachable: (failure) => unavailable(failure, checkFirst),
    ServiceFailed: (failure) => unavailable(failure, checkFirst),
    InvalidResponse: (failure) => unavailable(failure, checkFirst),
  });

export const resolveLinkResult = (
  outcome: Exclude<ResolvePaymentLinkOutcome, ResolvedPaymentLink>,
): LinkScreen =>
  Match.valueTags(outcome, {
    Pending: () => stillCreating,
    ApprovalOutstanding: () => stillCreating,
    PaymentLinkNotFound: () =>
      new LinkScreen(
        "No encontramos tu link",
        "No hay dinero en un link de este intento. Revisa tu saldo antes de crear otro.",
        "home",
      ),
    PaymentLinkReceiptInvalid: () =>
      new LinkScreen(
        "No pudimos confirmar tu link",
        "Revisa tus links: si aparece ahí, puedes recuperar el dinero.",
        "links",
      ),
    InvalidAddress: () =>
      new LinkScreen(
        "No pudimos leer tu llave",
        "La llave guardada en este dispositivo no es válida.",
        "home",
      ),
    NoWallet: () =>
      new LinkScreen(
        "No hay una cuenta aquí",
        "Este dispositivo no tiene una cuenta de Orchid.",
        "home",
      ),
    UnsupportedDevice: () =>
      new LinkScreen(
        "No pudimos leer tu llave",
        "Este navegador no puede leer tu llave de forma segura.",
        "home",
      ),
    Offline: (failure) => unavailable(failure, checkFirst),
    ServerUnreachable: (failure) => unavailable(failure, checkFirst),
    LedgerUnreachable: (failure) => unavailable(failure, checkFirst),
    ServiceFailed: (failure) => unavailable(failure, checkFirst),
    InvalidResponse: (failure) => unavailable(failure, checkFirst),
  });

const cannotRecover = (reason: string) =>
  new LinkScreen(
    "No podemos devolverte este dinero",
    `${reason} ${stillInLink}`,
    "done",
  );

const recoverAgain = new LinkScreen(
  "No pudimos recuperar el dinero",
  `Inténtalo de nuevo. ${stillInLink}`,
  "again",
);

const recheck = "Revisa de nuevo para saber si recuperaste el dinero.";

export const cancelLinkResult = (
  outcome: CancelPaymentLinkOutcome,
  link: RecoverableLink,
): LinkScreen => {
  const code = assetCode(link.asset);
  const amount = amountLabel(link.amount, link.asset);

  return Match.valueTags(outcome, {
    AssetSettled: () =>
      new LinkScreen(
        "Recuperaste tu dinero",
        `${amount} volvió a tu cuenta. El link ya no funciona.`,
        "done",
      ),
    AssetPending: () =>
      new LinkScreen(
        "Recuperando tu dinero…",
        "Te mostramos el resultado apenas llegue.",
        "check",
      ),
    AssetFailed: () =>
      new LinkScreen(
        "No se recuperó el dinero",
        `La red no confirmó la operación. ${stillInLink}`,
        "again",
      ),
    BalanceGone: ({ status }) =>
      Match.value(status).pipe(
        Match.when(
          "reclaimed",
          () =>
            new LinkScreen(
              "Ya recuperaste este dinero",
              `${amount} volvió a tu cuenta. El link ya no funciona.`,
              "done",
            ),
        ),
        Match.when(
          "claimed",
          () =>
            new LinkScreen(
              "Alguien ya usó este link",
              `Quien tenía el link ya recibió ${amount}.`,
              "done",
            ),
        ),
        Match.when(
          "clawed_back",
          () =>
            new LinkScreen(
              "Este dinero ya no está en el link",
              `La empresa que emite ${code} retiró ${amount} de este link. No volverá a tu cuenta.`,
              "done",
            ),
        ),
        Match.when(
          "unresolved",
          () =>
            new LinkScreen(
              "No pudimos confirmar qué pasó",
              "Este link ya no tiene dinero, pero no podemos saber si alguien lo recibió o si volvió a ti. Revisa tu saldo.",
              "done",
            ),
        ),
        Match.exhaustive,
      ),
    RecipientCannotReceive: ({ reason }) =>
      cannotRecover(
        Match.value(reason).pipe(
          Match.when("no_account", () => "Tu cuenta no está activa."),
          Match.when(
            "no_trustline",
            () => `Tu cuenta no puede recibir ${code} en este momento.`,
          ),
          Match.when(
            "not_authorized",
            () =>
              `${code} no permite que tu cuenta reciba dinero en este momento.`,
          ),
          Match.when(
            "no_capacity",
            () =>
              `Tu cuenta no puede recibir esta cantidad de ${code} en este momento.`,
          ),
          Match.exhaustive,
        ),
      ),
    TrustlineLimitReached: ({ limit }) =>
      cannotRecover(
        `Tu cuenta ya tiene el máximo de ${limit} monedas y ${code} no está entre ellas.`,
      ),
    AssetUnsupported: () =>
      cannotRecover(`Tu cuenta no puede recibir ${code} en este momento.`),
    NotClaimable: ({ claimableAt }) =>
      Option.match(claimableAt, {
        onNone: () => recoverAgain,
        onSome: (at) =>
          new LinkScreen(
            "Aún no puedes recuperar este dinero",
            `Podrás recuperarlo desde el ${DateTime.toDate(at).toLocaleString(
              "es-PE",
              { dateStyle: "long", timeStyle: "short" },
            )}. ${stillInLink}`,
            "done",
          ),
      }),
    SenderBusy: () => busyRecovering,
    AssetBusy: () => busyRecovering,
    Unchanged: () => recoverAgain,
    TrustlineNotEmpty: () => recoverAgain,
    DraftRejected: () =>
      new LinkScreen("No pudimos confirmar la operación", recheck, "check"),
    NotOpened: () =>
      new LinkScreen(
        "Aún no puedes recuperar dinero",
        "Tu cuenta aún se está activando.",
        "home",
      ),
    InvalidAddress: () =>
      new LinkScreen(
        "No pudimos leer tu llave",
        "La llave guardada en este dispositivo no es válida.",
        "home",
      ),
    NoWallet: () =>
      new LinkScreen(
        "No hay una cuenta aquí",
        "Este dispositivo no tiene una cuenta de Orchid.",
        "home",
      ),
    UnsupportedDevice: () =>
      new LinkScreen(
        "No pudimos leer tu llave",
        "Este navegador no puede leer tu llave de forma segura.",
        "home",
      ),
    Offline: (failure) => unavailable(failure, recheck),
    ServerUnreachable: (failure) => unavailable(failure, recheck),
    LedgerUnreachable: (failure) => unavailable(failure, recheck),
    ServiceFailed: (failure) => unavailable(failure, recheck),
    InvalidResponse: (failure) => unavailable(failure, recheck),
  });
};
