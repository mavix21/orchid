import { expect, layer } from "@effect/vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AddressBound,
  NeedsReopening,
  Profile,
  SigningRequest,
  Username,
  UsernameRecipient,
  UsernameTaken,
} from "../src/contract";
import { Sealed } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { usernames } from "../src/server/tables.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  amount,
  approve,
  claimFor,
  create,
  findWallet,
  fundedWallet,
  opening,
  orderFor,
  overviewOf,
  send,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

useDisposableDatabase();

const placeholderRequest = () =>
  new SigningRequest({
    envelope: Schema.decodeSync(SigningRequest.fields.envelope)("AAAA"),
    expiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
  });

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
            (yield* opening(second, approve(redraft.request, key)))._tag,
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
                approve(draft.request, keys[i] ?? keys[0]),
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
            (yield* opening(renamed, approve(retry.request, loser)))._tag,
          ).toBe("OpeningPending");
          expect(world.submitted).toHaveLength(2);
        }),
    );

    it.effect(
      "the binding write refuses a taken name even when the soft check is skipped",
      () =>
        Effect.gen(function* () {
          yield* create(Keypair.random(), "maria");
          const claim = claimFor(Keypair.random(), "maria");
          const row = yield* Directory.use((d) => d.start(claim.address));

          const draft = yield* Directory.use((d) =>
            d.draft(row, placeholderRequest()),
          );

          expect(
            yield* Directory.use((d) =>
              d.seal(draft, placeholderSealed(), claim),
            ),
          ).toEqual(new UsernameTaken({ username: claim.username }));

          const stored = Option.getOrThrow(yield* findWallet(claim.address));

          expect(stored.attemptHash).toBeNull();
          expect(stored.version).toBe(draft.version);
        }),
    );

    it.effect(
      "a stale binding write stores neither the attempt nor the name",
      () =>
        Effect.gen(function* () {
          const claim = claimFor(Keypair.random(), "maria");
          const row = yield* Directory.use((d) => d.start(claim.address));

          yield* Directory.use((d) => d.draft(row, placeholderRequest()));

          const written = yield* Directory.use((d) =>
            d.seal(row, placeholderSealed(), claim),
          );

          if (
            written instanceof UsernameTaken ||
            written instanceof AddressBound
          )
            throw new Error("Expected current row");

          expect(written.attemptHash).toBeNull();

          const second = Keypair.random();
          const secondClaim = claimFor(second, "maria");
          const draft = yield* opening(secondClaim);

          assertTagged(draft, "OpeningDraft");
          expect(
            (yield* opening(secondClaim, approve(draft.request, second)))._tag,
          ).toBe("OpeningPending");
        }),
    );

    it.effect.each(["my_orchid", "support", "soporte"])(
      "reserved name %s is never bound",
      (name) =>
        Effect.gen(function* () {
          const key = Keypair.random();

          expect(yield* opening(claimFor(key, name))).toEqual(
            new UsernameTaken({ username: Schema.decodeSync(Username)(name) }),
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
          yield* opening(claim, approve(draft.request, key));
          expect((yield* overviewOf(claim.address))._tag).toBe(
            "NeedsReopening",
          );
          expect((yield* send(recoveredOrder))._tag).toBe("UnknownRecipient");

          const recovery = yield* opening(claim);

          assertTagged(recovery, "RecoveryDraft");
          expect(
            (yield* opening(claim, approve(recovery.request, key)))._tag,
          ).toBe("Opened");
          expect((yield* overviewOf(claim.address))._tag).toBe("Holding");

          const reopenedDraft = yield* send(recoveredOrder);

          assertTagged(reopenedDraft, "TransferDraft");
          expect(reopenedDraft.recipient.address).toBe(claim.address);
        }),
    );

    it.effect(
      "a name bound before it was reserved stays usable by its address",
      () =>
        Effect.gen(function* () {
          const claim = claimFor(Keypair.random(), "soporte");
          const row = yield* Directory.use((d) => d.start(claim.address));

          yield* Database.use((db) => db.insert(usernames).values(claim));
          const sealed = placeholderSealed();

          const updated = yield* Directory.use((d) =>
            d.seal(row, sealed, claim),
          );

          if (
            updated instanceof UsernameTaken ||
            updated instanceof AddressBound
          )
            throw new Error("Expected existing owner to keep reserved name");

          expect(updated.attemptHash).toBe(sealed.hash);
          expect(
            (yield* opening(claimFor(Keypair.random(), "soporte")))._tag,
          ).toBe("UsernameTaken");
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
              d.activate(row, placeholderSealed(), facts, claim),
            ),
          ).toEqual(new UsernameTaken({ username: claim.username }));
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).status,
          ).toBe("opening");
        }),
    );
  },
);
