import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Approval,
  ExternalRecipient,
  Holding,
  InvalidAddress,
  NotSponsored,
  ExternalMemoRequired,
  InsufficientBalance,
  NeedsReopening,
  NotOpened,
  Opened,
  OpeningDraft,
  OpeningPending,
  OpenStep,
  Overview,
  Pending,
  PhoneNotSupported,
  Receipt,
  RecoveryDraft,
  ResolvedRecipient,
  SenderBusy,
  SigningRequest,
  TransferDraft,
  TransferOrder,
  TransferStep,
  UnknownRecipient,
  UsernameTaken,
  WalletClaim,
  type WalletPort,
  WalletUnavailable,
} from "../contract";
import { RecoveryFacts, readEnvelope } from "../stellar/envelopes";
import { approvalMargin } from "../stellar/network";
import { type AccountState, Chain, ChainUnreachable, Sealed } from "./Chain.server";
import {
  Directory,
  StoreFailure,
  Taken,
  type WalletRow,
  openingAttempt,
  profile,
} from "./Directory.server";
import {
  Authorized,
  Concluded,
  OrderJson,
  Proposed,
  SlotTaken,
  type Transfer,
  Transfers,
  pending,
} from "./Transfers.server";

export class Wallet extends Context.Service<
  Wallet,
  WalletPort & { readonly sweep: Effect.Effect<void, WalletUnavailable> }
>()("@workspace/wallet/server/Wallet") {
  static readonly serviceLayer = Layer.effect(
    Wallet,
    Effect.gen(function* () {
      const chain = yield* Chain;
      const directory = yield* Directory;
      const transfers = yield* Transfers;

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.mapError((cause) => new WalletUnavailable({ cause })));

      const live = (request: SigningRequest) =>
        DateTime.toEpochMillis(request.expiresAt) > Date.now() + approvalMargin * 1000;

      // A single negative observation is not enough to destroy durable state.
      const readAccount = Effect.fn("Wallet.readAccount")(function* (address: AccountAddress) {
        const first = yield* chain.account(address);

        return Option.isNone(first) || Option.isNone(first.value.balance)
          ? yield* chain.account(address)
          : first;
      });

      const readBalance = (address: AccountAddress) =>
        readAccount(address).pipe(Effect.map(Option.flatMap((state) => state.balance)));

      const reconcile = Effect.fn("Wallet.reconcile")(function* (authorized: Authorized) {
        const settlement = yield* chain.settlement(authorized.sealed);

        return yield* Match.valueTags(settlement, {
          Applied: (evidence) =>
            transfers
              .conclude(authorized.order.id, evidence)
              .pipe(Effect.map((done) => done.receipt)),
          Rejected: (evidence) =>
            transfers
              .conclude(authorized.order.id, evidence)
              .pipe(Effect.map((done) => done.receipt)),
          Expired: (evidence) =>
            transfers
              .conclude(authorized.order.id, evidence)
              .pipe(Effect.map((done) => done.receipt)),
          Undecided: () =>
            chain.submit(authorized.sealed).pipe(Effect.ignore, Effect.as(pending(authorized))),
        });
      });

      const recoveryStage = Effect.fn("Wallet.recoveryStage")(function* (
        row: WalletRow,
        state: AccountState,
        approval: Option.Option<Approval>,
      ): Effect.fn.Return<OpenStep, StoreFailure | ChainUnreachable> {
        const address = Schema.decodeSync(AccountAddress)(row.address);

        if (!state.sponsored) return new NotSponsored();

        const stored =
          row.recoveryDraft && row.recoveryMaxTime
            ? new SigningRequest({
                envelope: Schema.decodeSync(SigningRequest.fields.envelope)(row.recoveryDraft),
                expiresAt: DateTime.makeUnsafe(row.recoveryMaxTime),
              })
            : undefined;

        const facts = stored ? readEnvelope(stored.envelope) : Option.none();

        if (
          !stored ||
          !live(stored) ||
          Option.isNone(facts) ||
          !(facts.value instanceof RecoveryFacts) ||
          BigInt(facts.value.sequence) !== BigInt(state.sequence) + 1n
        ) {
          const request = yield* chain.draftRecovery(address);
          const written = yield* directory.recoveryDraft(row, request);

          if (written.status === "active") return new Opened({ profile: profile(written) });

          if (!written.recoveryDraft || !written.recoveryMaxTime) return new OpeningPending();

          return new RecoveryDraft({
            request: new SigningRequest({
              envelope: Schema.decodeSync(SigningRequest.fields.envelope)(written.recoveryDraft),
              expiresAt: DateTime.makeUnsafe(written.recoveryMaxTime),
            }),
          });
        }

        if (Option.isNone(approval)) return new RecoveryDraft({ request: stored });

        const sealed = yield* chain.seal(stored, approval.value, address).pipe(Effect.option);

        if (Option.isNone(sealed)) return new RecoveryDraft({ request: stored });

        const fresh = yield* readAccount(address);

        if (
          Option.isNone(fresh) ||
          fresh.value.sequence !== state.sequence ||
          Option.isNone(fresh.value.balance) ||
          !fresh.value.sponsored
        )
          return new OpeningPending();

        const active = yield* directory.activate(row, sealed.value, facts.value);

        return Option.isSome(active) ? new Opened({ profile: active.value }) : new OpeningPending();
      });

      const open = Effect.fn("Wallet.open")(function* (
        claim: WalletClaim,
        approval: Option.Option<Approval>,
      ): Effect.fn.Return<OpenStep, StoreFailure | ChainUnreachable> {
        if (!chain.validAddress(claim.address))
          return new InvalidAddress({ address: claim.address });

        const state = yield* readAccount(claim.address);

        if (Option.isSome(state) && !state.value.accountSponsored) return new NotSponsored();

        const row = yield* directory.claim(claim);

        if (row instanceof Taken) return new UsernameTaken({ username: claim.username });

        const usable = Option.isSome(state) && Option.isSome(state.value.balance);

        if (row.status === "active") {
          if (usable) return new Opened({ profile: profile(row) });

          yield* directory.recover(row);

          return new OpeningPending();
        }

        if (usable && Option.isSome(state)) return yield* recoveryStage(row, state.value, approval);

        const attempt = openingAttempt(row);

        if (Option.isSome(attempt) && attempt.value instanceof Sealed) {
          const settlement = yield* chain.settlement(attempt.value);

          const unfinished = Match.valueTags(settlement, {
            Undecided: () => true,
            Applied: () => false,
            Rejected: () => false,
            Expired: () => false,
          });

          const expiredOpening = unfinished && (yield* chain.pastOpeningWindow(attempt.value));

          if (unfinished && !expiredOpening) {
            yield* chain.submit(attempt.value).pipe(Effect.ignore);

            return new OpeningPending();
          }

          if (expiredOpening) {
            const confirmed = yield* readAccount(claim.address);

            if (Option.isSome(confirmed) && Option.isSome(confirmed.value.balance))
              return yield* recoveryStage(row, confirmed.value, Option.none());
          }
        }

        if (
          Option.isSome(attempt) &&
          attempt.value instanceof SigningRequest &&
          live(attempt.value)
        ) {
          if (Option.isNone(approval)) return new OpeningDraft({ request: attempt.value });

          const sealed = yield* chain
            .seal(attempt.value, approval.value, claim.address)
            .pipe(Effect.option);

          if (Option.isNone(sealed)) return new OpeningDraft({ request: attempt.value });

          const written = yield* directory.attempt(row, sealed.value);
          const committed = openingAttempt(written);

          if (Option.isSome(committed) && committed.value instanceof Sealed)
            yield* chain.submit(committed.value).pipe(Effect.ignore);

          return new OpeningPending();
        }

        const request = yield* chain.draftOpening(claim.address);
        const written = yield* directory.attempt(row, request);
        const stored = openingAttempt(written);

        return Option.isSome(stored) && stored.value instanceof SigningRequest
          ? new OpeningDraft({ request: stored.value })
          : new OpeningPending();
      });

      const resumed = Effect.fn("Wallet.resumed")(function* (
        transfer: Transfer,
      ): Effect.fn.Return<TransferStep, StoreFailure | ChainUnreachable> {
        if (transfer instanceof Concluded) return transfer.receipt;

        if (transfer instanceof Authorized) return yield* reconcile(transfer);

        return new TransferDraft({ request: transfer.request, recipient: transfer.recipient });
      });

      const transfer = Effect.fn("Wallet.transfer")(function* (
        order: TransferOrder,
        approval: Option.Option<Approval>,
      ): Effect.fn.Return<TransferStep, StoreFailure | ChainUnreachable> {
        if (!chain.validAddress(order.from)) return new InvalidAddress({ address: order.from });

        const invalidRecipient = Match.valueTags(order.to, {
          Address: ({ value }) =>
            chain.validAddress(value) ? Option.none<AccountAddress>() : Option.some(value),
          Username: () => Option.none<AccountAddress>(),
          Phone: () => Option.none<AccountAddress>(),
        });

        if (Option.isSome(invalidRecipient))
          return new InvalidAddress({ address: invalidRecipient.value });

        if (
          Match.valueTags(order.to, {
            Phone: () => true,
            Username: () => false,
            Address: () => false,
          })
        )
          return new PhoneNotSupported();

        const existing = yield* transfers.find(order.id);

        if (Option.isSome(existing)) {
          const stored = existing.value;

          if (Schema.encodeSync(OrderJson)(stored.order) !== Schema.encodeSync(OrderJson)(order))
            return yield* new StoreFailure({
              cause: new Error("Transfer id cannot identify a different order"),
            });

          if (!(stored instanceof Proposed)) return yield* resumed(stored);

          if (stored.recipient instanceof ExternalRecipient) return new ExternalMemoRequired();

          if (live(stored.request)) {
            if (Option.isNone(approval))
              return new TransferDraft({ request: stored.request, recipient: stored.recipient });

            const sealed = yield* chain
              .seal(stored.request, approval.value, stored.order.from)
              .pipe(Effect.option);

            if (Option.isNone(sealed))
              return new TransferDraft({ request: stored.request, recipient: stored.recipient });

            const authorized = yield* transfers.authorize(stored, sealed.value);

            if (authorized instanceof SlotTaken) {
              const receipt = yield* reconcile(authorized.holder);

              return receipt instanceof Pending
                ? new SenderBusy({ inFlight: receipt })
                : new TransferDraft({ request: stored.request, recipient: stored.recipient });
            }

            return yield* resumed(authorized);
          }
        }

        const sender = yield* directory.byAddress(order.from);

        if (Option.isNone(sender) || sender.value.status !== "active") return new NotOpened();

        const held = yield* transfers.latestFrom(order.from);

        if (Option.isSome(held) && held.value instanceof Authorized) {
          const receipt = yield* reconcile(held.value);

          if (receipt instanceof Pending) return new SenderBusy({ inFlight: receipt });
        }

        const recipient = yield* Match.valueTags(order.to, {
          Username: ({ value }) =>
            directory
              .byUsername(value)
              .pipe(
                Effect.map((found): ResolvedRecipient | UnknownRecipient =>
                  Option.isSome(found) ? found.value : new UnknownRecipient({ username: value }),
                ),
              ),
          Address: ({ value }) =>
            directory
              .byAddress(value)
              .pipe(
                Effect.map((found) =>
                  Option.isSome(found) && found.value.status === "active"
                    ? profile(found.value)
                    : new ExternalMemoRequired(),
                ),
              ),
          Phone: () => Effect.die("Phone was rejected before recipient resolution"),
        });

        if (recipient instanceof UnknownRecipient || recipient instanceof ExternalMemoRequired)
          return recipient;

        const balance = yield* readBalance(order.from);

        if (Option.isNone(balance)) {
          yield* directory.recover(sender.value);

          return new NotOpened();
        }

        if (balance.value < order.amount)
          return new InsufficientBalance({ available: balance.value });

        const request = yield* chain.draftPayment(order.from, recipient.address, order.amount);
        const proposed = yield* transfers.propose(order, recipient, request);

        return yield* resumed(proposed);
      });

      const overview = Effect.fn("Wallet.overview")(function* (
        address: AccountAddress,
      ): Effect.fn.Return<Overview, StoreFailure | ChainUnreachable> {
        if (!chain.validAddress(address)) return new InvalidAddress({ address });

        const row = yield* directory.byAddress(address);

        if (Option.isNone(row)) return new NotOpened();

        if (row.value.status === "recovered")
          return new NeedsReopening({ profile: profile(row.value) });

        if (row.value.status !== "active") return new NotOpened();

        const latest = yield* transfers.latestFrom(address);
        let receipt: Option.Option<Receipt> = Option.none();

        if (Option.isSome(latest)) {
          if (latest.value instanceof Authorized)
            receipt = Option.some(yield* reconcile(latest.value));

          if (latest.value instanceof Concluded) receipt = Option.some(latest.value.receipt);
        }

        const balance = yield* readBalance(address);

        if (Option.isNone(balance)) {
          yield* directory.recover(row.value);

          return new NeedsReopening({ profile: profile(row.value) });
        }

        return new Holding({
          profile: profile(row.value),
          balance: balance.value,
          latest: receipt,
        });
      });

      const recoverWallet = Effect.fn("Wallet.recoverWallet")(function* (row: WalletRow) {
        const address = Schema.decodeSync(AccountAddress)(row.address);
        const current = yield* readAccount(address);

        if (Option.isNone(current) || Option.isNone(current.value.balance)) {
          yield* directory.recover(row);

          return;
        }

        if (
          !row.recoveryEnvelope ||
          !row.recoveryHash ||
          !row.recoveryMaxTime ||
          !row.recoveryMinTime
        )
          return;

        const sealed = new Sealed({
          envelope: row.recoveryEnvelope,
          hash: row.recoveryHash,
          expiresAt: DateTime.makeUnsafe(row.recoveryMaxTime),
        });

        const evidence = yield* chain.settlement(sealed);

        const merged = Match.valueTags(evidence, {
          Applied: () => true,
          Rejected: () => false,
          Expired: () => false,
          Undecided: () => false,
        });

        if (merged) {
          yield* directory.recover(row);

          return;
        }

        const undecided = Match.valueTags(evidence, {
          Undecided: () => true,
          Applied: () => false,
          Rejected: () => false,
          Expired: () => false,
        });

        if (
          undecided &&
          row.recoveryMinTime.getTime() <= Date.now() &&
          row.recoveryMaxTime.getTime() > Date.now() &&
          current.value.sponsored &&
          current.value.balance.value === 0n &&
          current.value.nativeBalance === 0n &&
          BigInt(current.value.sequence) + 1n === BigInt(row.recoverySequence ?? "0")
        )
          yield* chain.submit(sealed).pipe(Effect.ignore);
      });

      const sweep = Effect.gen(function* () {
        const inFlight = yield* transfers.inFlight;
        const wallets = yield* directory.recoverable;

        const results = yield* Effect.forEach(
          [
            ...inFlight.map((entry) => reconcile(entry).pipe(Effect.asVoid)),
            ...wallets.map(recoverWallet),
          ],
          (program) => program.pipe(Effect.result),
        );

        for (const result of results) {
          if (Result.isFailure(result))
            return yield* new WalletUnavailable({
              cause: new Error("One or more sweep records could not be reconciled"),
            });
        }
      });

      return Wallet.of({
        open: (claim, approval) => wrap(open(claim, approval)),
        transfer: (order, approval) => wrap(transfer(order, approval)),
        overview: (address) => wrap(overview(address)),
        sweep: wrap(sweep),
      });
    }),
  );
  static readonly layer = Wallet.serviceLayer.pipe(
    Layer.provide([Directory.layer, Transfers.layer, Chain.layer]),
  );
}
