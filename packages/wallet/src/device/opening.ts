import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  type Approval,
  OpeningPending,
  type OpenStep,
  type Username,
  WalletClaim,
  type WalletPort,
  type WalletUnavailable,
} from "../contract";
import { OpeningFacts, RecoveryFacts } from "../stellar/envelopes";
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
import { pendingPause, pendingSteps } from "./polling";
import { approve, liveFacts, signingKey } from "./signing";

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

  const advance = (
    wallet: DeviceWallet,
    approval: Option.Option<Approval>,
    remaining: number,
  ): Effect.Effect<CreateOutcome, WalletUnavailable | KeyStoreUnavailable> =>
    remaining === 0
      ? Effect.succeed(new OpeningPending())
      : port
          .open(
            new WalletClaim({
              username: wallet.username,
              address: wallet.address,
            }),
            approval,
          )
          .pipe(
            Effect.flatMap((step) =>
              respond(wallet, step, Option.isSome(approval), remaining - 1),
            ),
          );

  const respond = (
    wallet: DeviceWallet,
    step: OpenStep,
    submitted: boolean,
    remaining: number,
  ) =>
    Match.valueTags(step, {
      OpeningDraft: ({ request }) =>
        Effect.gen(function* () {
          const facts = yield* liveFacts(request);

          if (
            Option.isNone(facts) ||
            !(facts.value instanceof OpeningFacts) ||
            facts.value.address !== wallet.address
          )
            return new DraftRejected();

          const sponsored = yield* remember(
            store,
            new DeviceWallet({
              ...wallet,
              reserveSponsor: facts.value.reserveSponsor,
            }),
          );

          if (Option.isNone(sponsored)) return new UnsupportedDevice();

          return yield* advance(
            sponsored.value,
            Option.some(approve(request, signingKey(wallet.phrase))),
            remaining,
          );
        }),
      RecoveryDraft: ({ request }) =>
        Effect.gen(function* () {
          const facts = yield* liveFacts(request);

          if (
            Option.isNone(facts) ||
            !(facts.value instanceof RecoveryFacts) ||
            facts.value.address !== wallet.address ||
            facts.value.reserveSponsor !== wallet.reserveSponsor
          )
            return new DraftRejected();

          return yield* advance(
            wallet,
            Option.some(approve(request, signingKey(wallet.phrase))),
            remaining,
          );
        }),
      OpeningPending: () =>
        submitted
          ? advance(wallet, Option.none(), remaining)
          : Effect.sleep(pendingPause).pipe(
              Effect.andThen(advance(wallet, Option.none(), remaining)),
            ),
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
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(new UnsupportedDevice()),
                  onSome: (adopted) =>
                    advance(adopted, Option.none(), remaining),
                }),
              ),
            )
          : Effect.succeed(bound),
      Opened: Effect.succeed,
      UsernameTaken: Effect.succeed,
      InvalidAddress: Effect.succeed,
      NotSponsored: Effect.succeed,
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

    return yield* advance(enrolled, Option.none(), pendingSteps);
  });
}
