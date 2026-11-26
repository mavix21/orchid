import type {
  ConfirmLinkReceiveOutcome,
  LinkReceiveReview,
  WalletUnavailable,
} from "@workspace/wallet";
import * as Match from "effect/Match";

import type { DeviceFailure } from "@/send/use-wallet-task";
import { LinkScreen } from "@/links/outcomes";
import { retryable, unavailableMessage } from "@/wallet/unavailable";

export type ReceiveAction = "home" | "again" | "check" | "done";

export type ReceiveConclusion =
  | Exclude<ConfirmLinkReceiveOutcome, LinkReceiveReview>
  | DeviceFailure;

const stillInLink = "El dinero sigue en el link.";

const used = new LinkScreen<ReceiveAction>(
  "Este link ya fue usado",
  "Ya no tiene dinero para recibir.",
  "done",
);

const unresolved = new LinkScreen<ReceiveAction>(
  "No pudimos confirmar qué pasó con este link",
  "Ya no tiene dinero, pero no podemos saber quién lo recibió.",
  "done",
);

const unrecognized = new LinkScreen<ReceiveAction>(
  "No reconocemos este link",
  "El dinero sigue en el link, pero no podemos cobrarlo desde aquí.",
  "done",
);

const checking = new LinkScreen<ReceiveAction>(
  "Estamos comprobando si se envió",
  "Revisa de nuevo en un momento.",
  "check",
);

const notReceived = (message: string, action: ReceiveAction = "again") =>
  new LinkScreen<ReceiveAction>(
    "No pudimos recibir este dinero",
    message,
    action,
  );

const unavailable = (failure: WalletUnavailable) =>
  notReceived(
    `${unavailableMessage(failure)} ${stillInLink}`,
    retryable(failure) ? "again" : "done",
  );

export const receiveScreen = (
  outcome: ReceiveConclusion,
  received: string,
): LinkScreen<ReceiveAction> =>
  Match.valueTags(outcome, {
    AssetSettled: () =>
      new LinkScreen<ReceiveAction>(
        `Recibiste ${received}`,
        "Ya está en tu cuenta de Orchid.",
        "home",
      ),
    AssetPending: () => checking,
    PaymentLinkChecking: () => checking,
    AssetFailed: () =>
      notReceived(
        "La operación no se completó. Revisa el link para saber si el dinero sigue ahí.",
        "check",
      ),
    BalanceGone: ({ status }) => (status === "unresolved" ? unresolved : used),
    PaymentLinkUsed: () => used,
    PaymentLinkUnresolved: () => unresolved,
    PaymentLinkUnrecognized: () => unrecognized,
    PaymentLinkNotFound: () =>
      new LinkScreen<ReceiveAction>(
        "No encontramos este link",
        "Revisa que lo hayas abierto completo desde el mensaje que te enviaron.",
        "done",
      ),
    LinkCodeMismatch: () =>
      new LinkScreen<ReceiveAction>(
        "Este link está incompleto",
        "Ábrelo de nuevo desde el mensaje que te enviaron.",
        "done",
      ),
    InvalidAddress: () =>
      new LinkScreen<ReceiveAction>(
        "Este link no es válido",
        "Ábrelo de nuevo desde el mensaje que te enviaron.",
        "done",
      ),
    LinkUnclaimable: () =>
      new LinkScreen<ReceiveAction>(
        "No pudimos cobrar este link",
        "El dinero sigue disponible para quien lo envió.",
        "done",
      ),
    RecipientCannotReceive: () =>
      notReceived(
        `Tu cuenta no puede recibir esta moneda. ${stillInLink}`,
        "done",
      ),
    AssetUnsupported: () =>
      notReceived(
        `Tu cuenta no puede recibir esta moneda. ${stillInLink}`,
        "done",
      ),
    TrustlineLimitReached: () =>
      notReceived(
        `Tu cuenta no puede recibir esta moneda. ${stillInLink}`,
        "done",
      ),
    NotOpened: () =>
      notReceived(`Tu cuenta aún se está activando. ${stillInLink}`),
    SenderBusy: () =>
      notReceived(`Tienes otra operación en curso. ${stillInLink}`),
    AssetBusy: () =>
      notReceived(`Tienes otra operación en curso. ${stillInLink}`),
    NotClaimable: () => notReceived(`Inténtalo de nuevo. ${stillInLink}`),
    Unchanged: () => notReceived(`Inténtalo de nuevo. ${stillInLink}`),
    TrustlineNotEmpty: () => notReceived(`Inténtalo de nuevo. ${stillInLink}`),
    DraftRejected: () =>
      notReceived(`La solicitud cambió antes de firmarse. ${stillInLink}`),
    NoWallet: () =>
      notReceived(
        `Este dispositivo no tiene una cuenta de Orchid. ${stillInLink}`,
      ),
    UnsupportedDevice: () =>
      notReceived(
        `Este navegador no puede guardar tu llave de forma segura. ${stillInLink}`,
        "done",
      ),
    PasskeyCancelled: () =>
      notReceived(`Cancelaste el uso de tu passkey. ${stillInLink}`),
    PasskeyFailed: () =>
      notReceived(`No pudimos usar tu passkey. ${stillInLink}`),
    WrongCredential: () =>
      notReceived(`Usaste una passkey distinta. ${stillInLink}`),
    AssertionRejected: () =>
      notReceived(`No pudimos verificar tu passkey. ${stillInLink}`),
    PrfOutputMissing: () =>
      notReceived(
        `Tu passkey no abrió tu cuenta en este dispositivo. ${stillInLink}`,
        "done",
      ),
    CorruptDeviceWallet: () =>
      notReceived(
        `Los datos guardados en este navegador están dañados. ${stillInLink}`,
        "done",
      ),
    DeviceFailure: () =>
      notReceived(`Algo falló en este dispositivo. ${stillInLink}`, "check"),
    Offline: unavailable,
    ServerUnreachable: unavailable,
    LedgerUnreachable: unavailable,
    ServiceFailed: unavailable,
    SessionRequired: unavailable,
    RateLimited: unavailable,
    InvalidResponse: unavailable,
  });

export const receiveRefusal = (outcome: ReceiveConclusion) => {
  const screen = receiveScreen(outcome, "");

  return `${screen.title}. ${screen.message}`;
};
