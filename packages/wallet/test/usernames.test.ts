import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AddressBound,
  HumanCheckRefused,
  NeedsReopening,
  Profile,
  Username,
  UsernameRecipient,
  UsernameTaken,
} from "../src/contract";
import { Sealed } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  amount,
  bindingAllowed,
  approveOpening,
  claimFor,
  create,
  findWallet,
  fundedWallet,
  opening,
  orderFor,
  overviewOf,
  send,
  settleAttempt,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const placeholderSealed = () =>
  new Sealed({
    envelope: "AAAA",
    hash: "00".repeat(32),
    expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
  });

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "a name is bound only by the signed opening; drafts reserve nothing",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const first = claimFor(key, "maria");
          const draft = yield* opening(first);

          assertTagged(draft, "OpeningDraft");

          const second = claimFor(key, "maria2");
          const redraft = yield* opening(second);

          assertTagged(redraft, "OpeningDraft");
          expect(
            (yield* opening(claimFor(Keypair.random(), "maria")))._tag,
          ).toBe("OpeningDraft");
          expect(
            (yield* opening(second, approveOpening(key, redraft)))._tag,
          ).toBe("OpeningPending");
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
          const claims = keys.map((k) => claimFor(k, "maria"));

          const drafts = yield* Effect.all(
            claims.map((c) => opening(c)),
            { concurrency: "unbounded" },
          );

          const results = yield* Effect.all(
            drafts.map((draft, i) => {
              assertTagged(draft, "OpeningDraft");

              return opening(
                claims[i] ?? claims[0],
                approveOpening(keys[i] ?? keys[0], draft),
              );
            }),
            { concurrency: "unbounded" },
          );

          expect(
            results.filter(Predicate.isTagged("OpeningPending")),
          ).toHaveLength(1);
          expect(
            results.filter(Predicate.isTagged("UsernameTaken")),
          ).toHaveLength(1);
          expect(world.submitted).toHaveLength(1);

          const loser =
            keys[results.findIndex(Predicate.isTagged("UsernameTaken"))] ??
            keys[0];

          const renamed = claimFor(loser, "maria_2");
          const retry = yield* opening(renamed);

          assertTagged(retry, "OpeningDraft");
          expect(
            (yield* opening(renamed, approveOpening(loser, retry)))._tag,
          ).toBe("OpeningPending");
          expect(world.submitted).toHaveLength(2);
        }),
    );

    it.effect(
      "a refused human check binds nothing and a later passing check binds the name",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");
          const draft = yield* opening(claim);

          assertTagged(draft, "OpeningDraft");
          world.humanCheckRefused = true;
          expect(yield* opening(claim, approveOpening(key, draft))).toEqual(
            new HumanCheckRefused(),
          );
          expect(world.submitted).toHaveLength(0);
          expect(
            (yield* opening(claimFor(Keypair.random(), "maria")))._tag,
          ).toBe("OpeningDraft");
          world.humanCheckRefused = false;
          expect((yield* opening(claim, approveOpening(key, draft)))._tag).toBe(
            "OpeningPending",
          );
          expect(yield* opening(claimFor(Keypair.random(), "maria"))).toEqual(
            new UsernameTaken({ username: claim.username }),
          );
        }),
    );

    it.effect(
      "the human check runs without the wallet's locks, and a wallet changed meanwhile binds nothing",
      () =>
        Effect.gen(function* () {
          const claim = claimFor(Keypair.random(), "maria");
          const draft = yield* opening(claim);

          assertTagged(draft, "OpeningDraft");

          const stored = Option.getOrThrow(yield* findWallet(claim.address));

          const written = yield* Directory.use((directory) =>
            directory.seal(
              stored,
              placeholderSealed(),
              claim,
              Option.none(),
              false,
              directory
                .recoveryDraft(stored, draft.request)
                .pipe(
                  Effect.orDie,
                  Effect.as(Option.none<HumanCheckRefused>()),
                ),
            ),
          );

          expect(written).toMatchObject({ version: stored.version + 1 });
          expect(
            (yield* opening(claimFor(Keypair.random(), "maria")))._tag,
          ).toBe("OpeningDraft");
        }),
    );

    it.effect("a reserved name is never bound", () =>
      Effect.gen(function* () {
        const key = Keypair.random();

        expect(yield* opening(claimFor(key, "soporte"))).toEqual(
          new UsernameTaken({
            username: Schema.decodeSync(Username)("soporte"),
          }),
        );
        expect(Option.isNone(yield* findWallet(addressOf(key)))).toBe(true);
        expect(world.submitted).toHaveLength(0);
      }),
    );

    it.effect(
      "a username becomes payable on activation, stays bound during recovery and resolves again when reopened",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("rosa");
          const key = Keypair.random();

          const toMaria = UsernameRecipient.make({
            value: Schema.decodeSync(Username)("maria"),
          });

          expect((yield* send(orderFor(sender, toMaria)))._tag).toBe(
            "UnknownRecipient",
          );

          const claim = yield* create(key, "maria");
          const activeDraft = yield* send(orderFor(sender, toMaria));

          assertTagged(activeDraft, "TransferDraft");
          expect(activeDraft.recipient.address).toBe(claim.address);

          world.accounts.delete(claim.address);
          expect(yield* overviewOf(claim.address)).toEqual(
            new NeedsReopening({ profile: new Profile(claim) }),
          );
          expect(
            (yield* findWallet(claim.address)).pipe(
              Option.map((r) => r.status),
            ),
          ).toEqual(Option.some("recovered"));

          const recoveredOrder = orderFor(sender, toMaria);

          expect((yield* send(recoveredOrder))._tag).toBe("UnknownRecipient");
          expect(
            (yield* opening(claimFor(Keypair.random(), "maria")))._tag,
          ).toBe("UsernameTaken");
          expect(yield* opening(claimFor(key, "maria2"))).toEqual(
            new AddressBound({ profile: new Profile(claim) }),
          );

          const draft = yield* opening(claim);

          assertTagged(draft, "OpeningDraft");
          world.humanCheckRefused = true;
          yield* opening(claim, approveOpening(key, draft));
          world.humanCheckRefused = false;
          expect((yield* overviewOf(claim.address))._tag).toBe(
            "NeedsReopening",
          );
          expect((yield* send(recoveredOrder))._tag).toBe("UnknownRecipient");
          yield* settleAttempt(claim.address);
          expect((yield* opening(claim))._tag).toBe("Opened");
          expect((yield* overviewOf(claim.address))._tag).toBe("Holding");

          const reopenedDraft = yield* send(recoveredOrder);

          assertTagged(reopenedDraft, "TransferDraft");
          expect(reopenedDraft.recipient.address).toBe(claim.address);
        }),
    );

    it.effect(
      "activation refuses a name another key bound after the recovery draft",
      () =>
        Effect.gen(function* () {
          const claim = claimFor(Keypair.random(), "maria");

          world.accounts.set(
            claim.address,
            accountState({ balance: Option.some(amount("0")) }),
          );
          const recovery = yield* opening(claim);

          assertTagged(recovery, "RecoveryDraft");
          const row = Option.getOrThrow(yield* findWallet(claim.address));

          const facts = Option.getOrThrow(
            readEnvelope(recovery.request.envelope),
          );

          assertTagged(facts, "RecoveryFacts");

          yield* create(Keypair.random(), "maria");
          expect(
            yield* Directory.use((d) =>
              d.activate(
                row,
                placeholderSealed(),
                facts,
                claim,
                bindingAllowed,
              ),
            ),
          ).toEqual(new UsernameTaken({ username: claim.username }));
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).status,
          ).toBe("opening");
        }),
    );
  },
);
