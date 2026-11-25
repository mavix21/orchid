import type { SessionRefusal } from "@workspace/wallet";
import * as Match from "effect/Match";

import { unavailableMessage } from "./unavailable";

export const sessionRefusal = (outcome: SessionRefusal) =>
  Match.valueTags(outcome, {
    PasskeyCancelled: () => "No usaste tu passkey. Inténtalo de nuevo.",
    PasskeyFailed: () => "No pudimos usar tu passkey. Inténtalo de nuevo.",
    WrongCredential: () =>
      "Usaste una passkey distinta. Vuelve a intentarlo con la passkey de tu cuenta.",
    AssertionRejected: () =>
      "No pudimos verificar tu passkey. Confirma con tu huella, rostro o PIN del dispositivo e inténtalo de nuevo.",
    AssertionRefused: () =>
      "Orchid no pudo verificar tu passkey. Inténtalo de nuevo.",
    ChallengeRefused: () =>
      "La confirmación tardó demasiado. Inténtalo de nuevo.",
    NoBackup: () =>
      "Esta cuenta no tiene una passkey de respaldo, así que no podemos confirmar que eres tú.",
    NoWallet: () => "Este dispositivo no tiene una cuenta de Orchid.",
    UnsupportedDevice: () =>
      "Este navegador no puede leer tu llave de forma segura.",
    CorruptDeviceWallet: () =>
      "Los datos guardados en este navegador están dañados.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    SessionRequired: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });
