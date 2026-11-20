import type { WalletUnavailable } from "@workspace/wallet";
import * as Match from "effect/Match";

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
