import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  type Approval,
  OpeningPending,
  type Username,
  WalletClaim,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import {
  type KeyStore,
  type KeyStoreUnavailable,
  PublicDeviceWallet,
} from "./key-store";
import {
  type CreateOutcome,
  DraftRejected,
  NoWallet,
  UnsupportedDevice,
} from "./outcomes";
import { pollSchedule } from "./polling";
import { approve, liveFacts, signingKey } from "./signing";

interface OpeningTurn {
  readonly done: Option.Option<CreateOutcome>;
  readonly pause: boolean;
}

export function openWallet(port: WalletPort, store: KeyStore) {
  const advance = Effect.fn("Device.advanceOpening")(function* (
    initial: PublicDeviceWallet,
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

            const nextSponsor = facts.value.reserveSponsor;

            const sponsored = yield* store.updatePublic((current) =>
              current.address === wallet.address &&
              current.reserveSponsor !== nextSponsor
                ? Option.some(
                    new PublicDeviceWallet({
                      ...current,
                      reserveSponsor: nextSponsor,
                    }),
                  )
                : Option.none(),
            );

            if (
              Option.isNone(sponsored) ||
              sponsored.value.wallet.address !== wallet.address ||
              sponsored.value.wallet.reserveSponsor !== nextSponsor
            )
              return {
                done: Option.some(new UnsupportedDevice()),
                pause: false,
              };

            const secret = yield* store.read();

            if (
              Option.isNone(secret) ||
              secret.value.address !== wallet.address
            )
              return {
                done: Option.some(new UnsupportedDevice()),
                pause: false,
              };

            wallet = sponsored.value.wallet;
            approval = Option.some(
              approve(request, signingKey(secret.value.phrase)),
            );

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

            const secret = yield* store.read();

            if (
              Option.isNone(secret) ||
              secret.value.address !== wallet.address
            )
              return {
                done: Option.some(new UnsupportedDevice()),
                pause: false,
              };

            approval = Option.some(
              approve(request, signingKey(secret.value.phrase)),
            );

            return { done: Option.none(), pause: false };
          }),
        OpeningPending: () =>
          Effect.succeed({ done: Option.none(), pause: !submitted }),
        AddressBound: (bound) =>
          bound.profile.address === wallet.address &&
          bound.profile.username !== wallet.username
            ? store
                .updatePublic((current) =>
                  current.address === wallet.address &&
                  current.username !== bound.profile.username
                    ? Option.some(
                        new PublicDeviceWallet({
                          ...current,
                          username: bound.profile.username,
                        }),
                      )
                    : Option.none(),
                )
                .pipe(
                  Effect.map((adopted): OpeningTurn => {
                    if (
                      Option.isNone(adopted) ||
                      adopted.value.wallet.address !== wallet.address ||
                      adopted.value.wallet.username !== bound.profile.username
                    )
                      return {
                        done: Option.some(new UnsupportedDevice()),
                        pause: false,
                      };

                    wallet = adopted.value.wallet;

                    return { done: Option.none(), pause: false };
                  }),
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
    const existing = yield* store.readPublic();

    if (Option.isNone(existing)) return new NoWallet();

    if (existing.value.backup !== "stored") return new UnsupportedDevice();

    const prepared = yield* store.updatePublic((current) =>
      current.address === existing.value.address &&
      current.username !== username
        ? Option.some(new PublicDeviceWallet({ ...current, username }))
        : Option.none(),
    );

    if (
      Option.isNone(prepared) ||
      prepared.value.wallet.address !== existing.value.address ||
      prepared.value.wallet.username !== username
    )
      return new UnsupportedDevice();

    return yield* advance(prepared.value.wallet);
  });
}
