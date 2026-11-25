import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  Approval,
  AssetOrder,
  AssetOrderId,
  BalanceId,
  ClaimBalance,
  CredentialId,
  ReceiveLink,
} from "../src/contract";
import { Principal, SessionCookie } from "../src/server/Principal.server";
import { mintedClaims, sealToken } from "../src/server/session-token.server";
import { assertTagged } from "./tagged";
import {
  addressOf,
  claimFor,
  dbLayer,
  fundedWallet,
  opening,
  useDisposableDatabase,
  walletForDb,
  walletTestLayer,
} from "./wallet-harness";

const credentialId = Schema.decodeSync(CredentialId)("Y3JlZGVudGlhbA");
const balance = Schema.decodeSync(BalanceId)(`00000000${"a".repeat(64)}`);

const tokenFor = (address: AccountAddress, secret = "session-secret") =>
  sealToken(
    Redacted.make(secret),
    mintedClaims(address, credentialId, Date.now()),
  );

const walletRequest = Layer.fresh(walletForDb(dbLayer));

const atRequest = <A, E>(
  cookie: Option.Option<string>,
  program: Effect.Effect<A, E, Principal>,
) =>
  program.pipe(
    Effect.provide(walletRequest),
    Effect.provideService(SessionCookie, cookie),
  );

const speaksFor = (address: AccountAddress) =>
  Principal.use((principal) => principal.speaksFor(address));

const order = (wallet: AccountAddress, action: AssetOrder["action"]) =>
  new AssetOrder({
    id: Schema.decodeSync(AssetOrderId)(crypto.randomUUID()),
    wallet,
    action,
  });

const receiving = (wallet: AccountAddress) =>
  order(wallet, ReceiveLink.make({ link: wallet, balance }));

const signed = Option.some(
  new Approval({ signature: Keypair.random().sign(Buffer.from("approval")) }),
);

const refusals = [
  {
    name: "another wallet's address",
    cookie: (own: AccountAddress) => tokenFor(own),
    asking: () => addressOf(Keypair.random()),
  },
  {
    name: "a missing cookie",
    cookie: () => Effect.succeed(undefined),
    asking: (own: AccountAddress) => own,
  },
  {
    name: "an altered token",
    cookie: (own: AccountAddress) =>
      Effect.map(tokenFor(own), (token) => `${token.slice(0, -2)}AA`),
    asking: (own: AccountAddress) => own,
  },
  {
    name: "a token sealed with another secret",
    cookie: (own: AccountAddress) => tokenFor(own, "another-secret"),
    asking: (own: AccountAddress) => own,
  },
];

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect("answers for the wallet its live session carries", () =>
      Effect.gen(function* () {
        const own = addressOf(Keypair.random());

        const token = yield* tokenFor(own);

        yield* atRequest(Option.some(token), speaksFor(own));
      }),
    );

    it.effect.each(refusals)(
      "refuses $name with SessionRequired",
      ({ cookie, asking }) =>
        Effect.gen(function* () {
          const own = addressOf(Keypair.random());
          const presented = yield* cookie(own);

          const refusal = yield* Effect.flip(
            atRequest(Option.fromNullishOr(presented), speaksFor(asking(own))),
          );

          assertTagged(refusal, "SessionRequired");
        }),
    );

    it.effect(
      "drafts a receive into a wallet still opening without a session, but never with an approval or another action",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const wallet = addressOf(key);

          assertTagged(yield* opening(claimFor(key, "nuevo")), "OpeningDraft");

          const refusalOf = (
            drafted: AssetOrder,
            approval: Option.Option<Approval>,
          ) =>
            atRequest(
              Option.none(),
              Principal.use((principal) =>
                principal.admitsDrafting(drafted, approval),
              ),
            ).pipe(Effect.flip, Effect.option);

          expect(yield* refusalOf(receiving(wallet), Option.none())).toEqual(
            Option.none(),
          );

          assertTagged(
            Option.getOrThrow(yield* refusalOf(receiving(wallet), signed)),
            "SessionRequired",
          );
          assertTagged(
            Option.getOrThrow(
              yield* refusalOf(
                order(wallet, ClaimBalance.make({ balance })),
                Option.none(),
              ),
            ),
            "SessionRequired",
          );
        }),
    );

    it.effect(
      "refuses a receive into an active wallet without its session",
      () =>
        Effect.gen(function* () {
          const active = addressOf(yield* fundedWallet("maria"));

          const refusal = yield* Effect.flip(
            atRequest(
              Option.none(),
              Principal.use((principal) =>
                principal.admitsDrafting(receiving(active), Option.none()),
              ),
            ),
          );

          assertTagged(refusal, "SessionRequired");
        }),
    );
  },
);
