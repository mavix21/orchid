import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { makeDatabase } from "@workspace/db";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AddressBound,
  PhoneRecipient,
  NeedsReopening,
  Opened,
  OpeningDraft,
  OpeningPending,
  PhoneNotSupported,
  Profile,
  RecoveryDraft,
  TransferDraft,
  Amount,
  Username,
  UsernameRecipient,
  UsernameTaken,
  UnknownRecipient,
} from "../src/contract";
import { Directory } from "../src/server/Directory.server";
import { usernames } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { RecoveryFacts, readEnvelope } from "../src/stellar/envelopes";
import {
  dbLayer,
  world,
  addressOf,
  approve,
  claimFor,
  opening,
  create,
  orderFor,
  send,
  placeholderRequest,
  placeholderSealed,
  fundHolder,
  useDisposableDatabase,
  walletTestLayer,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect("phone recipients return a typed refusal", () =>
      Effect.gen(function* () {
        expect(
          yield* send(
            orderFor(
              Keypair.random(),
              PhoneRecipient.make({ value: "+51999999999" }),
            ),
          ),
        ).toBeInstanceOf(PhoneNotSupported);
      }),
    );

    it.effect(
      "a name is bound only by the signed opening; drafts reserve nothing",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const first = claimFor(key, "maria");
          const draft = yield* opening(first);

          if (!(draft instanceof OpeningDraft))
            throw new Error("Expected draft");

          // Asking for another name before signing is not a conflict with the abandoned first choice.
          const second = claimFor(key, "maria2");
          const redraft = yield* opening(second);

          if (!(redraft instanceof OpeningDraft))
            throw new Error("Expected draft for the new name");

          expect(
            yield* opening(claimFor(Keypair.random(), "maria")),
          ).toBeInstanceOf(OpeningDraft);
          expect(
            yield* opening(second, approve(redraft.request, key)),
          ).toBeInstanceOf(OpeningPending);
          expect(yield* opening(first)).toEqual(
            new AddressBound({ profile: new Profile(second) }),
          );
          expect(yield* opening(claimFor(Keypair.random(), "maria2"))).toEqual(
            new UsernameTaken({ username: second.username }),
          );
        }),
    );

    it.effect(
      "concurrent signed openings bind a name once and the loser submits nothing",
      () =>
        Effect.gen(function* () {
          const keys = [Keypair.random(), Keypair.random()];
          const claims = keys.map((key) => claimFor(key, "maria"));

          const drafts = yield* Effect.all(
            claims.map((claim) => opening(claim)),
            { concurrency: "unbounded" },
          );

          const results = yield* Effect.all(
            drafts.map((draft, index) => {
              if (!(draft instanceof OpeningDraft))
                throw new Error("Expected draft");

              return opening(
                claims[index] ?? claims[0],
                approve(draft.request, keys[index] ?? keys[0]),
              );
            }),
            { concurrency: "unbounded" },
          );

          expect(
            results.filter((result) => result instanceof OpeningPending),
          ).toHaveLength(1);
          expect(
            results.filter((result) => result instanceof UsernameTaken),
          ).toHaveLength(1);
          expect(world.submitted).toHaveLength(1);

          const loser = results.findIndex(
            (result) => result instanceof UsernameTaken,
          );

          const key = keys[loser] ?? keys[0];
          const renamed = claimFor(key, "maria_2");
          const retry = yield* opening(renamed);

          if (!(retry instanceof OpeningDraft))
            throw new Error("Expected loser to redraft");

          expect(
            yield* opening(renamed, approve(retry.request, key)),
          ).toBeInstanceOf(OpeningPending);
          expect(world.submitted).toHaveLength(2);
        }),
    );

    it.effect(
      "the binding write refuses a taken name even when the soft check is skipped",
      () =>
        Effect.gen(function* () {
          yield* create(Keypair.random(), "maria");

          const key = Keypair.random();
          const claim = claimFor(key, "maria");

          const row = yield* Directory.use((directory) =>
            directory.start(claim.address),
          );

          const draft = yield* Directory.use((directory) =>
            directory.draft(row, placeholderRequest()),
          );

          const sealed = placeholderSealed();

          expect(
            yield* Directory.use((directory) =>
              directory.seal(draft, sealed, claim),
            ),
          ).toEqual(new UsernameTaken({ username: claim.username }));

          const stored = Option.getOrThrow(
            yield* Directory.use((directory) =>
              directory.byAddress(claim.address),
            ),
          );

          expect(stored.attemptHash).toBeNull();
          expect(stored.version).toBe(draft.version);
        }),
    );

    it.effect(
      "a stale binding write stores neither the attempt nor the name",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");

          const row = yield* Directory.use((directory) =>
            directory.start(claim.address),
          );

          const sealed = placeholderSealed();

          yield* Directory.use((directory) =>
            directory.draft(row, placeholderRequest()),
          );

          const written = yield* Directory.use((directory) =>
            directory.seal(row, sealed, claim),
          );

          if (
            written instanceof UsernameTaken ||
            written instanceof AddressBound
          )
            throw new Error("Expected the current row back");

          expect(written.attemptHash).toBeNull();
          expect(
            yield* opening(claimFor(Keypair.random(), "maria")),
          ).toBeInstanceOf(OpeningDraft);
        }),
    );

    it.effect("reserved names are never bound", () =>
      Effect.gen(function* () {
        const key = Keypair.random();

        const impersonations = [
          // Anything containing "orchid".
          "orchid",
          "orchid_help",
          "orchidsupport",
          "orchid_oficial",
          "my_orchid",
          // Exact reserved words in English and Spanish.
          "support",
          "admin",
          "security",
          "wallet",
          "official",
          "soporte",
          "ayuda",
          "seguridad",
          "oficial",
          "equipo",
          "billetera",
          "administrador",
        ];

        for (const name of impersonations) {
          expect(yield* opening(claimFor(key, name))).toEqual(
            new UsernameTaken({ username: Schema.decodeSync(Username)(name) }),
          );
        }

        expect(
          Option.isNone(
            yield* Directory.use((directory) =>
              directory.byAddress(addressOf(key)),
            ),
          ),
        ).toBe(true);
        expect(world.submitted).toHaveLength(0);
      }),
    );

    it.effect(
      "a recovered name stays bound to its address but is not payable until reopened",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const sender = Keypair.random();
          const claim = yield* create(key, "maria");

          yield* create(sender, "rosa");
          fundHolder(sender);
          world.accounts.delete(claim.address);
          expect(
            yield* Wallet.use((wallet) => wallet.overview(claim.address)),
          ).toEqual(new NeedsReopening({ profile: new Profile(claim) }));

          const order = orderFor(
            sender,
            UsernameRecipient.make({ value: claim.username }),
          );

          expect(yield* send(order)).toBeInstanceOf(UnknownRecipient);
          expect(
            yield* opening(claimFor(Keypair.random(), "maria")),
          ).toBeInstanceOf(UsernameTaken);
          expect(yield* opening(claimFor(key, "maria2"))).toEqual(
            new AddressBound({ profile: new Profile(claim) }),
          );

          const draft = yield* opening(claim);

          if (!(draft instanceof OpeningDraft))
            throw new Error("Expected reopening draft");

          // Repair is in progress: the wallet stays recovered and unpayable until activation.
          yield* opening(claim, approve(draft.request, key));
          expect(
            yield* Wallet.use((wallet) => wallet.overview(claim.address)),
          ).toBeInstanceOf(NeedsReopening);
          expect(yield* send(order)).toBeInstanceOf(UnknownRecipient);

          const recovery = yield* opening(claim);

          if (!(recovery instanceof RecoveryDraft))
            throw new Error("Expected recovery draft");

          expect(
            yield* opening(claim, approve(recovery.request, key)),
          ).toBeInstanceOf(Opened);
          expect(yield* send(order)).toBeInstanceOf(TransferDraft);
        }),
    );

    it.effect(
      "an existing account without a name binds it before activation",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");

          world.accounts.set(claim.address, {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("0")),
          });

          const recovery = yield* opening(claim);

          if (!(recovery instanceof RecoveryDraft))
            throw new Error("Expected recovery draft");

          expect(yield* opening(claim, approve(recovery.request, key))).toEqual(
            new Opened({ profile: new Profile(claim) }),
          );
          expect(
            yield* opening(claimFor(Keypair.random(), "maria")),
          ).toBeInstanceOf(UsernameTaken);
          expect(world.submitted).toHaveLength(0);
        }),
    );

    it.effect(
      "a name bound before it was reserved stays usable by its address",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "soporte");

          const row = yield* Directory.use((directory) =>
            directory.start(claim.address),
          );

          yield* makeDatabase().pipe(
            Effect.flatMap((db) => db.insert(usernames).values(claim)),
            Effect.provide(dbLayer),
          );

          expect(
            yield* Directory.use((directory) =>
              directory.seal(row, placeholderSealed(), claim),
            ),
          ).not.toBeInstanceOf(UsernameTaken);
          expect(
            yield* opening(claimFor(Keypair.random(), "soporte")),
          ).toBeInstanceOf(UsernameTaken);
        }),
    );

    it.effect(
      "activation refuses a name another key bound after the recovery draft",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");

          world.accounts.set(claim.address, {
            sequence: "1000",
            ledger: 100,
            accountSponsored: true,
            sponsored: true,
            nativeBalance: 0n,
            balance: Option.some(Schema.decodeSync(Amount)("0")),
          });

          const recovery = yield* opening(claim);

          if (!(recovery instanceof RecoveryDraft))
            throw new Error("Expected recovery draft");

          const row = Option.getOrThrow(
            yield* Directory.use((directory) =>
              directory.byAddress(claim.address),
            ),
          );

          const facts = Option.getOrThrow(
            readEnvelope(recovery.request.envelope),
          );

          if (!(facts instanceof RecoveryFacts))
            throw new Error("Expected recovery facts");

          // Another key binds the name after this soft check passed; the activation bind must refuse.
          yield* create(Keypair.random(), "maria");
          expect(
            yield* Directory.use((directory) =>
              directory.activate(row, placeholderSealed(), facts, claim),
            ),
          ).toEqual(new UsernameTaken({ username: claim.username }));
          expect(
            Option.getOrThrow(
              yield* Directory.use((directory) =>
                directory.byAddress(claim.address),
              ),
            ).status,
          ).toBe("opening");
        }),
    );

    it.effect(
      "a new user is payable by username immediately after activation",
      () =>
        Effect.gen(function* () {
          const sender = Keypair.random();
          const recipient = Keypair.random();

          yield* create(sender, "rosa");
          fundHolder(sender);

          const order = orderFor(
            sender,
            UsernameRecipient.make({
              value: Schema.decodeSync(Username)("maria"),
            }),
          );

          expect(yield* send(order)).toBeInstanceOf(UnknownRecipient);
          yield* create(recipient, "maria");

          const draft = yield* send(order);

          if (!(draft instanceof TransferDraft))
            throw new Error("Expected draft to the new user");

          expect(draft.recipient.address).toBe(addressOf(recipient));
        }),
    );
  },
);
