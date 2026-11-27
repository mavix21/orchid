import {
  type Asset,
  Profile,
  type Receipt,
  type ResolvedRecipient,
  type ResumeOutcome,
  type TransferOrder,
  formatAmount,
  precisionOf,
} from "@workspace/wallet";
import * as Match from "effect/Match";

import { amountLabel, shortAddress } from "./money";
import { FieldProblem } from "./intent";

export type NextAction = "done" | "home" | "retry" | "wait" | "check";

export class SendScreen {
  constructor(
    readonly title: string,
    readonly message: string,
    readonly action: NextAction,
    readonly outstanding?: TransferOrder,
  ) {}
}

export type SendResult = FieldProblem | SendScreen;

const recipientName = (recipient: ResolvedRecipient) =>
  recipient instanceof Profile
    ? `@${recipient.username}`
    : shortAddress(recipient.address);

const accepting = (recipient: ResolvedRecipient) =>
  `Enviado. ${recipientName(recipient)} lo recibirá cuando lo acepte`;

const untouched = "Tu dinero no se movió";

const maybeMoving =
  "Si ya confirmaste, tu pago puede seguir en curso: no lo envíes de nuevo";

export const deviceFailure = new SendScreen(
  "Algo falló en este dispositivo",
  "Si ya confirmaste, tu pago puede seguir en curso: no lo envíes de nuevo",
  "home",
);

export const sendResult = (
  outcome: ResumeOutcome | Receipt,
  asset: Asset,
): SendResult =>
  Match.valueTags(outcome, {
    Settled: (settled) =>
      new SendScreen(
        "Enviado",
        settled.unclaimedFunds === undefined
          ? `${amountLabel(settled.amount, settled.asset)} a ${recipientName(settled.recipient)}`
          : accepting(settled.recipient),
        "done",
      ),
    Reserved: ({ recipient }) =>
      new SendScreen("Enviado", accepting(recipient), "done"),
    Claimed: ({ recipient }) =>
      new SendScreen(
        "Enviado",
        `${recipientName(recipient)} aceptó tu pago`,
        "done",
      ),
    Refunded: ({ recipient }) =>
      new SendScreen(
        "Devuelto",
        `${recipientName(recipient)} no aceptó tu pago. Tu dinero volvió a tu cuenta`,
        "done",
      ),
    Failed: ({ reason }) =>
      new SendScreen(
        "No se envió",
        reason === "expired"
          ? `No se envió a tiempo. ${untouched}`
          : `La red rechazó el pago. ${untouched}`,
        "retry",
      ),
    Pending: () =>
      new SendScreen(
        "Enviando…",
        "Tu pago está en camino. Te mostramos el resultado apenas llegue",
        "check",
      ),
    NotOpened: () =>
      new SendScreen(
        "Aún no puedes enviar",
        "Tu cuenta aún se está activando",
        "home",
      ),
    UnknownRecipient: ({ username }) =>
      new FieldProblem("recipient", `No existe @${username}`),
    InvalidAddress: () =>
      new FieldProblem("recipient", "La dirección no es válida"),
    ExternalMemoRequired: () =>
      new FieldProblem(
        "memo",
        "Este destino necesita memo: sin él tu dinero puede perderse",
      ),
    MemoNotAllowed: ({ reason }) =>
      new FieldProblem(
        "memo",
        reason === "muxed"
          ? "Esta dirección ya identifica tu cuenta en el exchange; no necesita memo"
          : "Los pagos entre usuarios de Orchid no llevan memo",
      ),
    RecipientCannotReceive: ({ reason }) =>
      new FieldProblem(
        "recipient",
        Match.value(reason).pipe(
          Match.when("no_account", () => "Esa cuenta no existe en Stellar"),
          Match.when(
            "no_trustline",
            () => `Esa cuenta no acepta ${asset.code} todavía`,
          ),
          Match.when(
            "not_authorized",
            () => `El emisor de ${asset.code} no autoriza esa cuenta`,
          ),
          Match.when(
            "no_capacity",
            () => `Esa cuenta no puede recibir tanto ${asset.code} por ahora`,
          ),
          Match.exhaustive,
        ),
      ),
    InsufficientBalance: ({ available }) =>
      new FieldProblem(
        "amount",
        `Tienes ${amountLabel(available, asset)} disponibles`,
      ),
    UnclaimedFundsLimitReached: ({ limit }) =>
      new SendScreen(
        "Espera a que acepten tus pagos",
        `Tienes ${limit} pagos esperando ser aceptados`,
        "home",
      ),
    AssetUnsupported: () => new SendScreen("No se envió", untouched, "home"),
    SenderBusy: () =>
      new SendScreen(
        "Espera un momento",
        "Tienes otra operación en curso",
        "wait",
      ),
    AssetBusy: () =>
      new SendScreen(
        "Espera un momento",
        "Tienes otra operación en curso",
        "wait",
      ),
    PhoneNotSupported: () =>
      new FieldProblem("recipient", "Los envíos por teléfono llegan pronto"),
    ApprovalOutstanding: ({ order }) =>
      new SendScreen(
        "Tienes un pago en curso",
        "Tienes un pago firmado que aún no termina. Espera su resultado antes de enviar otro",
        "retry",
        order,
      ),
    DraftRejected: () =>
      new SendScreen(
        "No firmamos este pago",
        `No firmamos este pago porque no coincide con lo que escribiste o ya venció. ${untouched}`,
        "retry",
      ),
    Offline: () =>
      new SendScreen(
        "Sin conexión",
        "Sin conexión. Si ya confirmaste, revisaremos el pago al volver",
        "retry",
      ),
    ServerUnreachable: () =>
      new SendScreen(
        "No pudimos conectar con Orchid",
        "Inténtalo de nuevo en unos minutos. Si ya confirmaste, revisaremos el pago al reintentar",
        "retry",
      ),
    LedgerUnreachable: () =>
      new SendScreen(
        "La red Stellar no responde",
        "Inténtalo de nuevo en unos minutos. Si ya confirmaste, revisaremos el pago al reintentar",
        "retry",
      ),
    ServiceFailed: () =>
      new SendScreen(
        "Algo falló de nuestro lado",
        `Ya quedó registrado. ${maybeMoving}`,
        "home",
      ),
    SessionRequired: () =>
      new SendScreen(
        "Confirma tu passkey",
        `Necesitamos confirmar que eres tú. ${maybeMoving}`,
        "retry",
      ),
    RateLimited: () =>
      new SendScreen(
        "Demasiadas solicitudes seguidas",
        `Espera un momento e inténtalo de nuevo. ${maybeMoving}`,
        "retry",
      ),
    InvalidResponse: () =>
      new SendScreen("No pudimos leer la respuesta", maybeMoving, "home"),
    NoWallet: () =>
      new SendScreen(
        "No hay una cuenta aquí",
        "Este dispositivo no tiene una cuenta de Orchid",
        "home",
      ),
    UnsupportedDevice: () =>
      new SendScreen(
        "No pudimos leer tu llave",
        "Este navegador no puede leer tu llave de forma segura",
        "home",
      ),
    NoTransfer: () =>
      new SendScreen(
        "No encontramos ese pago",
        "Este dispositivo no tiene un pago en curso",
        "home",
      ),
  });

export const outstandingLabel = (order: TransferOrder) =>
  `${formatAmount(order.amount, precisionOf(order.asset))} ${order.asset.code} a ${Match.valueTags(
    order.to,
    {
      Username: ({ value }) => `@${value}`,
      Address: ({ value }) => shortAddress(value),
      PaymentLink: ({ value }) => shortAddress(value),
      Phone: ({ value }) => value,
    },
  )}`;
