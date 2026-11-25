import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldError, FieldLabel } from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import {
  currentUntil,
  type EnrollWalletOutcome,
  type EnrollmentPending,
  type ReadLinkCode,
  receiveCurrentUntil,
  type ReviewEnrollmentReceiveOutcome,
  type UsernameIssue,
  usernameIssue,
  usernameMaxLength,
  usernameMinLength,
  type WalletClient,
  type WalletEnrolled,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { OrchidPending } from "@/components/orchid-pending";
import { Screen, ScreenActions } from "@/components/screen";
import { TopNav, type TopNavAction } from "@/components/top-nav";
import { UserAvatar } from "@/components/user-avatar";
import { me } from "@/fixtures/account";
import { receiveRefusal } from "@/links/receive-outcomes";
import { displayLock } from "@/wallet/display-lock";
import { enrollmentClient } from "@/wallet/enrollment";
import {
  EnrollmentEvent,
  EnrollmentStage,
  type Moment,
  advanceEnrollment,
  notice,
  receiveFor,
  stoppedBy,
} from "@/wallet/enrollment-machine";
import { PendingStep, StepLabel } from "@/wallet/enrollment-pending-step";
import {
  HumanCheckWidget,
  useHumanCheckStatus,
} from "@/wallet/human-check-widget";
import { OpeningFlow } from "@/wallet/opening-flow";

const issueMessage = (issue: UsernameIssue) =>
  Match.valueTags(issue, {
    ForbiddenCharacter: ({ character }) =>
      /\s/u.test(character)
        ? "No puede tener espacios."
        : /\p{L}/u.test(character)
          ? "Usa letras sin tildes ni ñ."
          : "Solo letras, números y guion bajo.",
    UsernameTooLong: () => `Máximo ${usernameMaxLength} caracteres.`,
    UsernameTooShort: () => `Mínimo ${usernameMinLength} caracteres.`,
  });

const resignedNotice = notice(
  "La solicitud se actualizó. Confirma otra vez con tu passkey.",
);

interface EnrollmentFlowProps {
  title: string;
  back: (disabled: boolean) => TopNavAction;
  walletClient: WalletClient;
  receive?: ReadLinkCode;
  onEnrolled: (enrolled: WalletEnrolled) => void;
  onOpened: () => void;
}

export function EnrollmentFlow({
  title,
  back,
  walletClient,
  receive,
  onEnrolled,
  onOpened,
}: EnrollmentFlowProps) {
  const [stage, dispatch] = useReducer(
    advanceEnrollment,
    EnrollmentStage.Checking(),
  );

  const [username, setUsername] = useState("");
  const [touched, setTouched] = useState(false);
  const humanCheck = useHumanCheckStatus();

  useEffect(() => {
    let current = true;

    void Promise.all([walletClient.saved(), enrollmentClient.pending()]).then(
      ([saved, pending]) => {
        if (!current) return;

        const savedName = Predicate.isTagged(saved, "SavedWallet")
          ? Option.some(saved.username)
          : Option.none<string>();

        setUsername(
          Option.match(pending, {
            onSome: (found) => found.username,
            onNone: () => Option.getOrElse(savedName, () => ""),
          }),
        );

        dispatch(
          EnrollmentEvent.Checked({
            pending,
            saved: Option.isNone(pending) ? savedName : Option.none(),
            problem: Predicate.isTagged(saved, "UnsupportedDevice")
              ? Option.some(
                  stoppedBy(
                    "Este navegador no puede guardar tu llave de forma segura.",
                  ),
                )
              : Option.none(),
          }),
        );
      },
    );

    return () => {
      current = false;
    };
  }, [walletClient]);

  const readReceive = (answer: ReviewEnrollmentReceiveOutcome) => {
    if (Predicate.isTagged(answer, "EnrollmentPending")) {
      dispatch(
        EnrollmentEvent.Pending({ pending: answer, problem: Option.none() }),
      );

      return;
    }

    dispatch(
      EnrollmentEvent.ReceiveBlocked({
        problem: notice(receiveRefusal(answer)),
      }),
    );
  };

  const activeRecord = EnrollmentStage.$is("Activating")(stage)
    ? stage.pending
    : undefined;

  const awaitingReceive =
    EnrollmentStage.$is("Activating")(stage) &&
    !stage.receiveBlocked &&
    receive !== undefined &&
    stage.pending.stage === "activate" &&
    stage.pending.review !== undefined &&
    Option.isNone(receiveFor(stage.pending, receive));

  useEffect(() => {
    if (!awaitingReceive || receive === undefined) return;

    let current = true;

    void enrollmentClient.reviewReceive(receive.code).then((answer) => {
      if (current) readReceive(answer);
    });

    return () => {
      current = false;
    };
  }, [awaitingReceive, receive]);

  useEffect(() => {
    if (activeRecord === undefined) return;

    const { stage: step, review } = activeRecord;

    if (step !== "activate" || review === undefined) return;

    const shownReceive = receiveFor(activeRecord, receive);

    const remaining =
      Math.min(
        currentUntil(review),
        Option.match(shownReceive, {
          onNone: () => Number.POSITIVE_INFINITY,
          onSome: receiveCurrentUntil,
        }),
      ) - Date.now();

    if (remaining <= 0) return;

    let current = true;

    const timer = setTimeout(() => {
      dispatch(EnrollmentEvent.Refreshing());
      void enrollmentClient.pending().then(async (next) => {
        if (!current) return;

        if (Option.isNone(next)) {
          dispatch(EnrollmentEvent.Discarded());

          return;
        }

        dispatch(
          EnrollmentEvent.Pending({
            pending: next.value,
            problem: Option.none(),
          }),
        );

        if (Option.isSome(shownReceive) && receive !== undefined)
          readReceive(await enrollmentClient.reviewReceive(receive.code));
      });
    }, remaining);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [activeRecord, receive]);

  const finishOpening = async () => {
    const saved = await walletClient.saved();

    if (Predicate.isTagged(saved, "SavedWallet")) {
      setUsername(saved.username);
      dispatch(EnrollmentEvent.Finished({ username: saved.username }));

      return;
    }

    dispatch(
      EnrollmentEvent.Noted({
        problem: stoppedBy(
          "Ya existe una cuenta guardada en este dispositivo.",
        ),
      }),
    );
  };

  const answer = async (outcome: EnrollWalletOutcome, moment: Moment) => {
    await Match.value(outcome).pipe(
      Match.tag("EnrollmentPending", (next) => {
        setUsername(next.username);
        dispatch(
          EnrollmentEvent.Pending({ pending: next, problem: Option.none() }),
        );
      }),
      Match.tag("WalletEnrolled", onEnrolled),
      Match.tag("OpeningPending", finishOpening),
      Match.tag("WalletOnDevice", finishOpening),
      Match.orElse(async (refusal) => {
        dispatch(
          EnrollmentEvent.Refused({
            refusal,
            moment,
            pending: await enrollmentClient.pending(),
          }),
        );
      }),
    );
  };

  const typedIssue = usernameIssue(username);

  const blockingIssue = typedIssue.pipe(
    Option.filter((found) => !Predicate.isTagged(found, "UsernameTooShort")),
  );

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);

    if (Option.isSome(typedIssue)) return;

    dispatch(EnrollmentEvent.Submitted());
    void enrollmentClient
      .start(username)
      .then((outcome) => answer(outcome, "start"));
  };

  const confirm = (current: EnrollmentPending) => {
    const moment: Moment =
      current.stage === "activate" ? "activation" : "release";

    const shownReceive = Option.getOrUndefined(receiveFor(current, receive));
    const ticket = displayLock.begin();

    dispatch(EnrollmentEvent.Confirmed());
    void enrollmentClient
      .advance(
        current.review,
        receive !== undefined && shownReceive !== undefined
          ? { review: shownReceive, code: receive.code }
          : undefined,
        () => dispatch(EnrollmentEvent.Committing()),
      )
      .then(async (outcome) => {
        if (
          moment === "activation" &&
          (Predicate.isTagged(outcome, "WalletEnrolled") ||
            Predicate.isTagged(outcome, "OpeningPending"))
        )
          displayLock.unlock(ticket);

        if (
          current.review !== undefined &&
          Predicate.isTagged(outcome, "EnrollmentPending") &&
          outcome.stage === "activate"
        ) {
          dispatch(
            EnrollmentEvent.Pending({
              pending: outcome,
              problem: Option.some(resignedNotice),
            }),
          );

          return;
        }

        await answer(outcome, moment);
      });
  };

  const chooseAnother = () => {
    void enrollmentClient.discard().then(async (discarded) => {
      if (discarded) {
        dispatch(EnrollmentEvent.Discarded());

        return;
      }

      const next = await enrollmentClient.pending();

      if (Option.isSome(next))
        dispatch(
          EnrollmentEvent.Pending({
            pending: next.value,
            problem: Option.none(),
          }),
        );
    });
  };

  const busy =
    EnrollmentStage.$is("Confirming")(stage) ||
    (EnrollmentStage.$is("Choosing")(stage) && stage.busy);

  return (
    <Screen>
      <TopNav
        title={title}
        label="Atrás"
        icon={<ChevronLeftIcon />}
        disabled={busy}
        {...back(busy)}
      />
      {EnrollmentStage.$match(stage, {
        Checking: () => <OrchidPending title="Preparando tu cuenta…" />,
        Finishing: ({ username: name }) => (
          <>
            <div className="flex flex-1 flex-col">
              <OpeningFlow username={name} onOpened={onOpened} />
            </div>
            <HumanCheckWidget />
          </>
        ),
        Confirming: ({ pending, committing }) => {
          const opening = committing || pending.stage === "release";

          return (
            <OrchidPending
              title={
                opening
                  ? Option.isSome(receiveFor(pending, receive))
                    ? "Abriendo tu cuenta y recibiendo tu dinero…"
                    : "Abriendo tu cuenta…"
                  : "Confirma con tu passkey"
              }
              note={
                opening
                  ? "Esto toma unos segundos."
                  : "Tu dispositivo te la pedirá ahora."
              }
            />
          );
        },
        Activating: (current) => (
          <PendingStep
            current={current}
            receive={receive}
            onConfirm={() => confirm(current.pending)}
            onChooseAnother={chooseAnother}
            onRecheckReceive={() => dispatch(EnrollmentEvent.ReceiveRetried())}
          />
        ),
        Choosing: ({ problem: found, busy: starting }) => {
          const fieldMessage = Option.match(
            touched ? typedIssue : blockingIssue,
            {
              onNone: () => Option.getOrUndefined(found)?.message,
              onSome: issueMessage,
            },
          );

          const length = Array.from(username).length;

          return (
            <>
              <form
                id="choose-username"
                className="flex flex-1 flex-col"
                noValidate
                onSubmit={submit}
              >
                <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
                  <div className="flex flex-col gap-2">
                    <StepLabel>Paso 1 de 2</StepLabel>
                    <h1 className="font-display text-h1">Elige tu @usuario</h1>
                    <p className="text-body text-muted-foreground">
                      Así te encuentran para enviarte plata. Después crearás una
                      passkey para proteger tu cuenta.
                    </p>
                  </div>
                  <div className="flex justify-center">
                    <UserAvatar profile={me} size="xl" />
                  </div>
                  <Field>
                    <FieldLabel htmlFor="username">Usuario</FieldLabel>
                    <InputGroup>
                      <InputGroupAddon>@</InputGroupAddon>
                      <InputGroupInput
                        id="username"
                        name="username"
                        value={username}
                        onChange={(event) => {
                          setUsername(event.target.value.toLowerCase());
                          dispatch(EnrollmentEvent.Edited());
                        }}
                        onBlur={() => setTouched(username.length > 0)}
                        disabled={starting}
                        aria-invalid={fieldMessage ? true : undefined}
                        aria-describedby={
                          fieldMessage ? "username-error" : undefined
                        }
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        autoFocus
                      />
                      <InputGroupAddon align="inline-end">
                        <span
                          data-exceeded={length > usernameMaxLength}
                          className="text-label tabular-nums data-[exceeded=true]:text-destructive"
                        >
                          {length}/{usernameMaxLength}
                        </span>
                      </InputGroupAddon>
                    </InputGroup>
                    {fieldMessage ? (
                      <FieldError
                        id="username-error"
                        data-testid={
                          Option.exists(found, (shown) => shown.prfUnsupported)
                            ? "prf-unsupported"
                            : undefined
                        }
                      >
                        {fieldMessage}
                      </FieldError>
                    ) : null}
                    {Option.exists(found, (shown) => shown.takenName) ? (
                      <Link
                        to="/restore"
                        className="text-label text-primary underline-offset-4 hover:underline"
                      >
                        ¿Es tuyo? Entra con tu passkey
                      </Link>
                    ) : null}
                  </Field>
                </main>
              </form>
              <ScreenActions>
                <HumanCheckWidget />
                <Button
                  className="w-full"
                  type="submit"
                  form="choose-username"
                  data-testid="create-submit"
                  disabled={
                    starting ||
                    humanCheck !== "ready" ||
                    Option.exists(found, (shown) => shown.stopped) ||
                    username.length === 0 ||
                    Option.isSome(blockingIssue)
                  }
                >
                  {starting ? "Creando passkey…" : "Crear passkey"}
                </Button>
              </ScreenActions>
            </>
          );
        },
      })}
    </Screen>
  );
}
