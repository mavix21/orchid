import { expect, layer } from "@effect/vitest";
import {
  Account,
  Keypair,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  AddressBound,
  AddressRecipient,
  Opened,
  Profile,
  Username,
  WalletClaim,
} from "../src/contract";
import { Sealed } from "../src/server/Chain.server";
import { Directory } from "../src/server/Directory.server";
import { draftOpening, readEnvelope } from "../src/stellar/envelopes";
import { networkPassphrase } from "../src/stellar/network";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  amount,
  approveOpening,
  channel,
  bindingAllowed,
  claimFor,
  create,
  feePayer,
  findWallet,
  opening,
  orderFor,
  overviewOf,
  reserveSponsor,
  send,
  settleAttempt,
  sponsor,
  useDisposableDatabase,
  walletTestLayer,
  walletWithChain,
  world,
} from "./wallet-harness";

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "an opening activates only from its key's signature once its account is on the network",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");
          const draft = yield* opening(claim);

          assertTagged(draft, "OpeningDraft");
          expect(
            yield* opening(claim, approveOpening(Keypair.random(), draft)),
          ).toEqual(draft);
          expect(world.submitted).toHaveLength(0);
          expect((yield* opening(claim, approveOpening(key, draft)))._tag).toBe(
            "OpeningPending",
          );
          yield* settleAttempt(claim.address, 120);

          const visible = Option.getOrThrow(
            Option.fromNullishOr(world.accounts.get(claim.address)),
          );

          world.accounts.delete(claim.address);
          expect((yield* opening(claim))._tag).toBe("OpeningPending");
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).status,
          ).toBe("opening");
          world.accounts.set(claim.address, visible);
          expect(yield* opening(claim)).toEqual(
            new Opened({ profile: new Profile(claim) }),
          );
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).status,
          ).toBe("active");
        }),
    );

    it.effect("missing trustline reopens with the same username and key", () =>
      Effect.gen(function* () {
        const key = Keypair.random();
        const claim = yield* create(key, "maria");

        world.accounts.set(
          claim.address,
          accountState({ sequence: "2000", balance: Option.none() }),
        );
        expect((yield* overviewOf(claim.address))._tag).toBe("NeedsReopening");
        expect(
          (yield* findWallet(claim.address)).pipe(Option.map((r) => r.status)),
        ).toEqual(Option.some("recovered"));
        yield* create(key, "maria");
        expect((yield* overviewOf(claim.address))._tag).toBe("Holding");
      }),
    );

    it.effect(
      "a sealed opening outside RPC history redrafts after the ledger passes maxTime",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claim = claimFor(key, "maria");
          const row = yield* Directory.use((d) => d.start(claim.address));
          const now = Math.floor(Date.now() / 1000);

          const inner = TransactionBuilder.fromXDR(
            draftOpening({
              channel: new Account(channel, "100"),
              reserveSponsor,
              address: claim.address,
              createAccount: true,
              minTime: now - 200,
              maxTime: now - 80,
            }),
            networkPassphrase,
          );

          if (!(inner instanceof Transaction))
            throw new Error("Expected inner transaction");

          inner.sign(sponsor, key);

          const outer = TransactionBuilder.buildFeeBumpTransaction(
            feePayer.publicKey(),
            "100",
            inner,
            networkPassphrase,
          );

          outer.sign(feePayer);

          const historical = new Sealed({
            envelope: outer.toXDR(),
            hash: Buffer.from(outer.hash()).toString("hex"),
            expiresAt: DateTime.makeUnsafe((now - 80) * 1000),
          });

          yield* Directory.use((d) =>
            d.seal(row, historical, claim, bindingAllowed),
          );
          expect((yield* opening(claim))._tag).toBe("OpeningDraft");
          expect(world.submitted).toHaveLength(0);
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).attemptHash,
          ).toBeNull();
        }),
    );

    it.effect(
      "one missing RPC observation does not demote an active wallet",
      () =>
        Effect.gen(function* () {
          const claim = yield* create(Keypair.random(), "maria");
          let reads = 0;

          const transientWallet = walletWithChain((actual) => ({
            balance: (addr) =>
              ++reads === 1
                ? Effect.succeed(Option.none())
                : actual.balance(addr),
          }));

          expect(
            (yield* overviewOf(claim.address).pipe(
              Effect.provide(transientWallet),
            ))._tag,
          ).toBe("Holding");
          expect(
            Option.getOrThrow(yield* findWallet(claim.address)).status,
          ).toBe("active");
        }),
    );

    it.effect(
      "a partially sponsored account is refused before a username binds",
      () =>
        Effect.gen(function* () {
          const claim = claimFor(Keypair.random(), "maria");

          world.accounts.set(
            claim.address,
            accountState({
              balance: Option.some(amount("0")),
              accountSponsored: true,
              sponsored: false,
            }),
          );
          expect((yield* opening(claim))._tag).toBe("NotSponsored");
          expect(Option.isNone(yield* findWallet(claim.address))).toBe(true);
          expect(world.submitted).toHaveLength(0);
        }),
    );

    it.effect(
      "bad address checksums are typed refusals before username claims or drafts",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const valid = addressOf(key);

          const bad = Schema.decodeSync(AccountAddress)(
            `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`,
          );

          const claim = new WalletClaim({
            username: Schema.decodeSync(Username)("maria"),
            address: bad,
          });

          expect((yield* opening(claim))._tag).toBe("InvalidAddress");
          expect(Option.isNone(yield* findWallet(bad))).toBe(true);
          expect(
            (yield* send(orderFor(key, AddressRecipient.make({ value: bad }))))
              ._tag,
          ).toBe("InvalidAddress");
          expect(world.submitted).toHaveLength(0);
        }),
    );

    it.effect(
      "an existing unnamed account binds a username only with its key's signature",
      () =>
        Effect.gen(function* () {
          const key = Keypair.random();
          const claimA = claimFor(key, "alice");
          const claimB = claimFor(key, "bob");

          world.accounts.set(
            claimA.address,
            accountState({ balance: Option.some(amount("0")) }),
          );

          const draft = yield* opening(claimA);

          assertTagged(draft, "OpeningDraft");
          expect(
            Option.getOrThrow(readEnvelope(draft.request.envelope)),
          ).toMatchObject({ createAccount: false });
          expect(
            yield* opening(claimA, approveOpening(Keypair.random(), draft)),
          ).toEqual(draft);
          expect(
            (yield* opening(claimFor(Keypair.random(), "alice")))._tag,
          ).toBe("OpeningDraft");
          expect(
            (yield* opening(claimA, approveOpening(key, draft)))._tag,
          ).toBe("OpeningPending");
          yield* settleAttempt(claimA.address);
          expect(yield* opening(claimA)).toEqual(
            new Opened({ profile: new Profile(claimA) }),
          );
          expect(
            (yield* opening(claimFor(Keypair.random(), "alice")))._tag,
          ).toBe("UsernameTaken");
          expect(yield* opening(claimB)).toEqual(
            new AddressBound({ profile: new Profile(claimA) }),
          );
        }),
    );
  },
);
