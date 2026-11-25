import type {
  EnrollWalletOutcome,
  EnrollmentPending,
  LinkReceiveReview,
  ReadLinkCode,
} from "@workspace/wallet";
import { usernameMaxLength, usernameMinLength } from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { retryable, unavailableMessage } from "@/wallet/unavailable";

export type Refusal = Exclude<
  EnrollWalletOutcome,
  {
    _tag:
      | "EnrollmentPending"
      | "WalletEnrolled"
      | "OpeningPending"
      | "WalletOnDevice";
  }
>;

export type Moment = "start" | "activation" | "release";

export class Problem extends Data.Class<{
  readonly message: string;
  readonly prfUnsupported: boolean;
  readonly stopped: boolean;
  readonly takenName: boolean;
}> {}

export const notice = (message: string) =>
  new Problem({
    message,
    prfUnsupported: false,
    stopped: false,
    takenName: false,
  });

export const stoppedBy = (message: string) =>
  new Problem({
    message,
    prfUnsupported: false,
    stopped: true,
    takenName: false,
  });

const resignedMessage =
  "La solicitud se actualizó. Confirma otra vez con tu passkey.";

const unsupportedDeviceMessage =
  "Este navegador no puede guardar tu llave de forma segura.";

const lapsedMessage = "Tu solicitud venció. Vuelve a elegir tu @usuario.";

export const resignedProblem = notice(resignedMessage);

export const unsupportedDeviceProblem = stoppedBy(unsupportedDeviceMessage);

export type EnrollmentStep = Data.TaggedEnum<{
  Checking: {};
  Choosing: {
    readonly problem: Option.Option<Problem>;
    readonly busy: boolean;
  };
  Activating: {
    readonly pending: EnrollmentPending;
    readonly problem: Option.Option<Problem>;
    readonly receiveBlocked: boolean;
    readonly refreshing: boolean;
  };
  Confirming: {
    readonly pending: EnrollmentPending;
    readonly committing: boolean;
  };
  Finishing: { readonly username: string };
}>;

export const EnrollmentStep = Data.taggedEnum<EnrollmentStep>();

export type Activating = Extract<
  EnrollmentStep,
  { readonly _tag: "Activating" }
>;

export type EnrollmentEvent = Data.TaggedEnum<{
  Checked: {
    readonly pending: Option.Option<EnrollmentPending>;
    readonly saved: Option.Option<string>;
    readonly problem: Option.Option<Problem>;
  };
  Edited: {};
  Submitted: {};
  Confirmed: {};
  Committing: {};
  Pending: {
    readonly pending: EnrollmentPending;
    readonly problem: Option.Option<Problem>;
  };
  Refused: {
    readonly refusal: Refusal;
    readonly moment: Moment;
    readonly pending: Option.Option<EnrollmentPending>;
  };
  Noted: { readonly problem: Problem };
  ReceiveBlocked: { readonly problem: Problem };
  ReceiveRetried: {};
  Refreshing: {};
  Refreshed: { readonly pending: EnrollmentPending };
  Lapsed: {};
  Finished: { readonly username: string };
  Discarded: {};
}>;

export const EnrollmentEvent = Data.taggedEnum<EnrollmentEvent>();

const nameRule = `Solo letras, números y guion bajo, de ${usernameMinLength} a ${usernameMaxLength} caracteres.`;

const refusalMessage = (refusal: Refusal, moment: Moment) =>
  Match.valueTags(refusal, {
    InvalidUsername: () => nameRule,
    UsernameTaken: ({ username }) =>
      moment === "start"
        ? `@${username} ya está en uso. Elige otro.`
        : `@${username} se ocupó mientras creábamos tu cuenta. Elige otro @usuario.`,
    HumanCheckRefused: () =>
      "No pudimos verificar que eres una persona. Inténtalo de nuevo.",
    DraftRejected: () => resignedMessage,
    NoWallet: () => "Tu registro se interrumpió. Vuelve a elegir tu @usuario.",
    BackupUnsupported: () =>
      "Este dispositivo o navegador no es compatible con passkeys con PRF. Orchid necesita una passkey compatible para crear y proteger tu cuenta.",
    PasskeyCancelled: () =>
      moment === "start"
        ? "Cancelaste la creación de tu passkey."
        : "Cancelaste la confirmación. Tu cuenta aún no está creada.",
    PasskeyFailed: () => "No pudimos usar tu passkey. Inténtalo de nuevo.",
    WrongCredential: () =>
      "Usaste otra passkey. Confirma con la que acabas de crear.",
    AssertionRejected: () =>
      "No pudimos verificar tu passkey. Confirma con tu huella, rostro o PIN.",
    CorruptEnvelope: () =>
      "No pudimos cifrar tu llave en este dispositivo. Vuelve a empezar.",
    CorruptDeviceWallet: () =>
      "Los datos guardados en este navegador están dañados.",
    ChallengeRefused: () => lapsedMessage,
    RegistrationRefused: () =>
      "No pudimos registrar tu passkey. Vuelve a elegir tu @usuario.",
    UnsupportedDevice: () => unsupportedDeviceMessage,
    LinkSecretMismatch: () =>
      "Este link está incompleto. Ábrelo de nuevo desde el mensaje que te enviaron.",
    Offline: unavailableMessage,
    ServerUnreachable: unavailableMessage,
    LedgerUnreachable: unavailableMessage,
    ServiceFailed: unavailableMessage,
    SessionRequired: unavailableMessage,
    InvalidResponse: unavailableMessage,
  });

const problemOf = (refusal: Refusal, moment: Moment) =>
  new Problem({
    message: refusalMessage(refusal, moment),
    prfUnsupported: Predicate.isTagged(refusal, "BackupUnsupported"),
    stopped:
      !retryable(refusal) ||
      Predicate.isTagged(refusal, "UnsupportedDevice") ||
      Predicate.isTagged(refusal, "CorruptDeviceWallet"),
    takenName:
      Predicate.isTagged(refusal, "UsernameTaken") && moment === "start",
  });

const activating = (
  pending: EnrollmentPending,
  problem: Option.Option<Problem>,
) =>
  EnrollmentStep.Activating({
    pending,
    problem,
    receiveBlocked: false,
    refreshing: false,
  });

const choosing = (problem: Option.Option<Problem>) =>
  EnrollmentStep.Choosing({ problem, busy: false });

const whenActivating = (
  stage: EnrollmentStep,
  next: (current: Activating) => EnrollmentStep,
) => (EnrollmentStep.$is("Activating")(stage) ? next(stage) : stage);

export const advanceEnrollment = (
  stage: EnrollmentStep,
  event: EnrollmentEvent,
): EnrollmentStep =>
  Match.valueTags(event, {
    Checked: ({ pending, saved, problem }) =>
      Option.match(saved, {
        onSome: (username) => EnrollmentStep.Finishing({ username }),
        onNone: () =>
          Option.match(pending, {
            onSome: (current) => activating(current, problem),
            onNone: () => choosing(problem),
          }),
      }),
    Edited: () =>
      EnrollmentStep.$is("Choosing")(stage) &&
      Option.exists(stage.problem, (shown) => !shown.stopped)
        ? choosing(Option.none())
        : stage,
    Submitted: () =>
      EnrollmentStep.Choosing({ problem: Option.none(), busy: true }),
    Confirmed: () =>
      whenActivating(stage, ({ pending }) =>
        EnrollmentStep.Confirming({ pending, committing: false }),
      ),
    Committing: () =>
      EnrollmentStep.$is("Confirming")(stage)
        ? EnrollmentStep.Confirming({
            pending: stage.pending,
            committing: true,
          })
        : stage,
    Pending: ({ pending, problem }) => activating(pending, problem),
    Refused: ({ refusal, moment, pending }) => {
      const problem = Option.some(problemOf(refusal, moment));

      return Option.match(pending, {
        onSome: (current) => activating(current, problem),
        onNone: () => choosing(problem),
      });
    },
    Noted: ({ problem }) => choosing(Option.some(problem)),
    ReceiveBlocked: ({ problem }) =>
      whenActivating(stage, (current) =>
        EnrollmentStep.Activating({
          ...current,
          problem: Option.some(problem),
          receiveBlocked: true,
        }),
      ),
    ReceiveRetried: () =>
      whenActivating(stage, (current) =>
        EnrollmentStep.Activating({
          ...current,
          problem: Option.none(),
          receiveBlocked: false,
        }),
      ),
    Refreshing: () =>
      whenActivating(stage, (current) =>
        EnrollmentStep.Activating({ ...current, refreshing: true }),
      ),
    Refreshed: ({ pending }) =>
      whenActivating(stage, () => activating(pending, Option.none())),
    Lapsed: () =>
      whenActivating(stage, () => choosing(Option.some(notice(lapsedMessage)))),
    Finished: ({ username }) => EnrollmentStep.Finishing({ username }),
    Discarded: () => choosing(Option.none()),
  });

export const receiveFor = (
  current: EnrollmentPending,
  receive: ReadLinkCode | undefined,
): Option.Option<LinkReceiveReview> =>
  Option.filter(
    Option.fromNullishOr(current.receive),
    (shown) => receive !== undefined && shown.link === receive.link,
  );
