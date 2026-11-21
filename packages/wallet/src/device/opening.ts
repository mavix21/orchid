import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type Approval,
  OpeningPending,
  type Username,
  WalletClaim,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import { deviceBackup } from "./backup";
import {
  DeviceWallet,
  type KeyStore,
  type KeyStoreUnavailable,
  remember,
} from "./key-store";
import {
  type CreateOutcome,
  DraftRejected,
  UnsupportedDevice,
} from "./outcomes";
import type { Passkeys } from "./passkeys";
import { generateSecretPhrase } from "./secret-phrase";
import { pollSchedule } from "./polling";
import { approve, liveFacts, signingKey } from "./signing";

interface OpeningTurn {
  readonly done: Option.Option<CreateOutcome>;
  readonly pause: boolean;
}

export function openWallet(
  port: WalletPort,
  store: KeyStore,
  passkeys: Passkeys,
) {
  const { enroll } = deviceBackup(port, passkeys, store);

  const deviceWallet = Effect.fn("Device.wallet")(function* (
    username: Username,
  ) {
    const stored = yield* store.read();

    if (Option.isSome(stored))
      return new DeviceWallet({ ...stored.value, username });

    const phrase = generateSecretPhrase();

    return new DeviceWallet({
      phrase,
      address: Schema.decodeSync(AccountAddress)(
        signingKey(phrase).publicKey(),
      ),
      username,
    });
  });

  const advance = Effect.fn("Device.advanceOpening")(function* (
    initial: DeviceWallet,
  ): Effect.fn.Return<CreateOutcome, WalletUnavailable | KeyStoreUnavailable> {
    let wallet = initial;
    let approval: Option.Option<Approval> = Option.none();

    const step: Effect.Effect<
      OpeningTurn,
      WalletUnavailable | KeyStoreUnavailable
    > = Effect.gen(function* () {
      const submitted = Option.isSome(approval);

      const response = yield* port.open(
        new WalletClaim({
          username: wallet.username,
          address: wallet.address,
        }),
        approval,
      );

      approval = Option.none();

      return yield* Match.valueTags(response, {
        OpeningDraft: ({ request }) =>
          Effect.gen(function* () {
            const facts = yield* liveFacts(request);

            if (
              Option.isNone(facts) ||
              !Predicate.isTagged(facts.value, "OpeningFacts") ||
              facts.value.address !== wallet.address
            )
              return { done: Option.some(new DraftRejected()), pause: false };

            const sponsored = yield* remember(
              store,
              new DeviceWallet({
                ...wallet,
                reserveSponsor: facts.value.reserveSponsor,
              }),
            );

            if (Option.isNone(sponsored))
              return {
                done: Option.some(new UnsupportedDevice()),
                pause: false,
              };

            wallet = sponsored.value;
            approval = Option.some(approve(request, signingKey(wallet.phrase)));

            return { done: Option.none(), pause: false };
          }),
        RecoveryDraft: ({ request }) =>
          Effect.gen(function* () {
            const facts = yield* liveFacts(request);

            if (
              Option.isNone(facts) ||
              !Predicate.isTagged(facts.value, "RecoveryFacts") ||
              facts.value.address !== wallet.address ||
              facts.value.reserveSponsor !== wallet.reserveSponsor
            )
              return { done: Option.some(new DraftRejected()), pause: false };

            approval = Option.some(approve(request, signingKey(wallet.phrase)));

            return { done: Option.none(), pause: false };
          }),
        OpeningPending: () =>
          Effect.succeed({ done: Option.none(), pause: !submitted }),
        AddressBound: (bound) =>
          bound.profile.address === wallet.address &&
          bound.profile.username !== wallet.username
            ? remember(
                store,
                new DeviceWallet({
                  ...wallet,
                  username: bound.profile.username,
                }),
              ).pipe(
                Effect.map(
                  Option.match({
                    onNone: (): OpeningTurn => ({
                      done: Option.some(new UnsupportedDevice()),
                      pause: false,
                    }),
                    onSome: (adopted): OpeningTurn => {
                      wallet = adopted;

                      return { done: Option.none(), pause: false };
                    },
                  }),
                ),
              )
            : Effect.succeed({ done: Option.some(bound), pause: false }),
        Opened: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        UsernameTaken: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        InvalidAddress: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
        NotSponsored: (outcome) =>
          Effect.succeed({ done: Option.some(outcome), pause: false }),
      });
    });

    const last = yield* Effect.repeat(step, {
      schedule: pollSchedule<OpeningTurn>(
        (turn) => Option.isNone(turn.done),
        (turn) => turn.pause,
      ),
    });

    return Option.getOrElse(last.done, () => new OpeningPending());
  });

  return Effect.fn("Device.open")(function* (username: Username) {
    const wallet = yield* remember(store, yield* deviceWallet(username));

    if (Option.isNone(wallet)) return new UnsupportedDevice();

    const enrolled =
      wallet.value.backup === undefined &&
      wallet.value.reserveSponsor === undefined
        ? yield* enroll(wallet.value)
        : wallet.value;

    if (!(enrolled instanceof DeviceWallet)) return enrolled;

    return yield* advance(enrolled);
  });
}
