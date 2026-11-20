import { WalletUnavailable } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

export class UnavailableNotice {
  constructor(
    readonly message: string,
    readonly actionable: boolean,
  ) {}
}

export const unavailableNotice = (failure: WalletUnavailable) =>
  Match.valueTags(failure, {
    Offline: () =>
      new UnavailableNotice(
        "Sin conexión. Revisa tu internet e inténtalo de nuevo.",
        true,
      ),
    ServerUnreachable: () =>
      new UnavailableNotice(
        "No pudimos conectar con Orchid. Inténtalo de nuevo en unos minutos.",
        true,
      ),
    LedgerUnreachable: () =>
      new UnavailableNotice(
        "La red Stellar no responde. Inténtalo de nuevo en unos minutos.",
        true,
      ),
    ServiceFailed: () =>
      new UnavailableNotice(
        "Algo falló de nuestro lado. Ya quedó registrado para revisarlo.",
        false,
      ),
    InvalidResponse: () =>
      new UnavailableNotice("No pudimos leer la respuesta de Orchid.", false),
  });

export const unavailableMessage = (failure: WalletUnavailable) =>
  unavailableNotice(failure).message;

const isUnavailable = Schema.is(WalletUnavailable);

export const retryable = (outcome: { readonly _tag: string }) =>
  !isUnavailable(outcome) || unavailableNotice(outcome).actionable;
