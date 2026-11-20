import { portfolioFlow } from "./wallet-portfolio.server";
import { deliveryFlow } from "./wallet-delivery.server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  SigningRequest,
  AssetBusy,
  ClaimableLimitReached,
  Amount,
  assetKey,
  Approval,
  ExternalRecipient,
  Holding,
  InvalidAddress,
  MemoNotAllowed,
  ExternalMemoRequired,
  InsufficientBalance,
  NeedsReopening,
  NotOpened,
  Overview,
  PhoneNotSupported,
  Receipt,
  ResolvedRecipient,
  SenderBusy,
  TransferDraft,
  TransferOrder,
  TransferStep,
  UnknownRecipient,
  type WalletPort,
  type ServerFailure,
} from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import { Chain, ChainUnreachable, Sealed } from "./Chain.server";
import { Directory, StoreFailure, type WalletRow } from "./Directory.server";
import {
  Authorized,
  OrderJson,
  Proposed,
  type Transfer,
  Transfers,
  pending,
} from "./Transfers.server";
import { AssetOrders, assetPending } from "./AssetOrders.server";
import { assetFlow } from "./wallet-assets.server";
import { maxOpenClaimables } from "../stellar/network";
import { openingFlow } from "./wallet-opening.server";
import { Backups } from "./Backups.server";
import { concealFailure } from "./failures.server";
import { backupFlow } from "./wallet-backup.server";
import { confirmedReads, live } from "./wallet-reads.server";

export class Wallet extends Context.Service<
  Wallet,
  WalletPort<ServerFailure> & {
    readonly sweep: Effect.Effect<void, ServerFailure>;
  }
>()("@workspace/wallet/server/Wallet") {
  static readonly serviceLayer = Layer.effect(
    Wallet,
    Effect.gen(function* () {
      const chain = yield* Chain;
      const directory = yield* Directory;
      const transfers = yield* Transfers;
      const assets = yield* AssetOrders;
      const assetActions = yield* assetFlow;
      const delivery = yield* deliveryFlow;
      const portfolio = yield* portfolioFlow;

      const wrap = <A, E>(program: Effect.Effect<A, E>) =>
        program.pipe(Effect.catchCause(concealFailure));

      const { readAccount, readBalance } = yield* confirmedReads;
      const open = yield* openingFlow;
      const backup = yield* backupFlow;

      const reconcile = Effect.fn("Wallet.reconcile")(function* (
        authorized: Authorized,
      ) {
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
            chain
              .submit(authorized.sealed)
              .pipe(Effect.ignore, Effect.as(pending(authorized))),
        });
      });

      const memoRefusal = (
        order: TransferOrder,
        recipient: ResolvedRecipient,
      ): Option.Option<ExternalMemoRequired | MemoNotAllowed> => {
        if (!(recipient instanceof ExternalRecipient))
          return order.memo ? Option.some(new MemoNotAllowed()) : Option.none();

        const known = chain.memoRequiredFor(recipient.address);

        return Option.isSome(known) && !order.memo
          ? Option.some(
              new ExternalMemoRequired({
                address: recipient.address,
                exchange: known.value.exchange,
                source: known.value.source,
              }),
            )
          : Option.none();
      };

      const proposedStep = (
        proposed: Proposed,
      ): TransferDraft | ExternalMemoRequired | MemoNotAllowed => {
        const refusal = memoRefusal(proposed.order, proposed.recipient);

        if (Option.isSome(refusal)) return refusal.value;

        return new TransferDraft({
          request: proposed.request,
          recipient: proposed.recipient,
          memoRequired:
            proposed.recipient instanceof ExternalRecipient &&
            Option.isSome(chain.memoRequiredFor(proposed.recipient.address)),
        });
      };

      const resumed = Effect.fn("Wallet.resumed")(function* (
        transfer: Transfer,
      ): Effect.fn.Return<TransferStep, StoreFailure | ChainUnreachable> {
        return yield* Match.valueTags(transfer, {
          Concluded: (concluded) => Effect.succeed(concluded.receipt),
          Authorized: reconcile,
          Proposed: (proposed) => Effect.succeed(proposedStep(proposed)),
        });
      });

      const refreshDraft = Effect.fn("Wallet.refreshDraft")(function* (
        stored: Proposed,
      ) {
        const request = yield* delivery(stored.order, stored.recipient);

        if (!(request instanceof SigningRequest)) return stored;

        return yield* transfers.redraft(stored, request);
      });

      const currentDraft = Effect.fn("Wallet.currentDraft")(function* (
        stored: Proposed,
      ) {
        const state = yield* chain.account(stored.order.from);
        const facts = readEnvelope(stored.request.envelope);

        return (
          Option.isSome(state) &&
          Option.isSome(facts) &&
          (Predicate.isTagged(facts.value, "PaymentFacts") ||
            Predicate.isTagged(facts.value, "ClaimableFacts")) &&
          BigInt(state.value.sequence) + 1n === BigInt(facts.value.sequence)
        );
      });

      const transfer = Effect.fn("Wallet.transfer")(function* (
        order: TransferOrder,
        approval: Option.Option<Approval>,
      ): Effect.fn.Return<TransferStep, StoreFailure | ChainUnreachable> {
        if (!chain.validAddress(order.from))
          return new InvalidAddress({ address: order.from });

        const invalidRecipient = Match.valueTags(order.to, {
          Address: ({ value }) =>
            chain.validAddress(value)
              ? Option.none<AccountAddress>()
              : Option.some(value),
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

          if (
            Schema.encodeSync(OrderJson)(stored.order) !==
            Schema.encodeSync(OrderJson)(order)
          )
            return yield* new StoreFailure({
              cause: new Error("Transfer id cannot identify a different order"),
            });

          if (!Predicate.isTagged(stored, "Proposed"))
            return yield* resumed(stored);

          const refusal = memoRefusal(order, stored.recipient);

          if (Option.isSome(refusal)) return refusal.value;

          if (!(yield* currentDraft(stored)))
            return yield* resumed(yield* refreshDraft(stored));

          if (live(stored.request)) {
            if (Option.isNone(approval)) return proposedStep(stored);

            const sealed = yield* chain
              .seal(stored.request, approval.value, stored.order.from)
              .pipe(Effect.option);

            if (Option.isNone(sealed)) return proposedStep(stored);

            if (!(yield* currentDraft(stored)))
              return yield* resumed(yield* refreshDraft(stored));

            const authorized = yield* transfers.authorize(stored, sealed.value);

            return yield* Match.valueTags(authorized, {
              SlotTaken: ({ holder }) =>
                Effect.gen(function* () {
                  const receipt = yield* reconcile(holder);

                  return Predicate.isTagged(receipt, "Pending")
                    ? new SenderBusy({ inFlight: receipt })
                    : yield* resumed(
                        (yield* currentDraft(stored))
                          ? stored
                          : yield* refreshDraft(stored),
                      );
                }),
              ClaimablesFull: () =>
                Effect.succeed(
                  new ClaimableLimitReached({ limit: maxOpenClaimables }),
                ),
              SlotOccupied: () =>
                assets
                  .inFlightFor(order.from)
                  .pipe(
                    Effect.map((busy) =>
                      Option.isSome(busy)
                        ? new AssetBusy({ inFlight: assetPending(busy.value) })
                        : proposedStep(stored),
                    ),
                  ),
              Proposed: resumed,
              Authorized: resumed,
              Concluded: resumed,
            });
          }
        }

        const sender = yield* directory.byAddress(order.from);

        if (Option.isNone(sender) || sender.value.status !== "active")
          return new NotOpened();

        const held = yield* transfers.latestFrom(order.from);

        if (
          Option.isSome(held) &&
          Predicate.isTagged(held.value, "Authorized")
        ) {
          const receipt = yield* reconcile(held.value);

          if (Predicate.isTagged(receipt, "Pending"))
            return new SenderBusy({ inFlight: receipt });
        }

        const recipient = yield* Match.valueTags(order.to, {
          Username: ({ value }) =>
            directory
              .byUsername(value)
              .pipe(
                Effect.map((found): ResolvedRecipient | UnknownRecipient =>
                  Option.isSome(found)
                    ? found.value
                    : new UnknownRecipient({ username: value }),
                ),
              ),
          Address: ({ value }) =>
            directory
              .byAddress(value)
              .pipe(
                Effect.flatMap(
                  (found): Effect.Effect<ResolvedRecipient, StoreFailure> =>
                    Option.isSome(found) && found.value.status === "active"
                      ? directory.profile(found.value)
                      : Effect.succeed(
                          new ExternalRecipient({ address: value }),
                        ),
                ),
              ),
          Phone: () =>
            Effect.die("Phone was rejected before recipient resolution"),
        });

        if (Predicate.isTagged(recipient, "UnknownRecipient")) return recipient;

        const refusal = memoRefusal(order, recipient);

        if (Option.isSome(refusal)) return refusal.value;

        const state = yield* chain.holdings(
          order.from,
          Match.valueTags(order.asset, {
            Native: () => [],
            Issued: (asset) => [asset],
          }),
        );

        const balance = Option.map(state, (holding) =>
          Match.valueTags(order.asset, {
            Native: () => holding.native,
            Issued: (asset) =>
              holding.lines.find(
                (line) =>
                  assetKey(line.asset) === assetKey(asset) && line.authorized,
              )?.spendable ?? Schema.decodeSync(Amount)("0"),
          }),
        );

        if (Option.isNone(balance)) {
          yield* directory.recover(sender.value);

          return new NotOpened();
        }

        if (balance.value < order.amount)
          return new InsufficientBalance({ available: balance.value });

        const request = yield* delivery(order, recipient);

        if (!(request instanceof SigningRequest)) return request;

        const proposed = yield* transfers.propose(order, recipient, request);

        return yield* resumed(proposed);
      });

      const overview = Effect.fn("Wallet.overview")(function* (
        address: AccountAddress,
      ): Effect.fn.Return<Overview, StoreFailure | ChainUnreachable> {
        if (!chain.validAddress(address))
          return new InvalidAddress({ address });

        const row = yield* directory.byAddress(address);

        if (Option.isNone(row)) return new NotOpened();

        if (row.value.status === "recovered")
          return new NeedsReopening({
            profile: yield* directory.profile(row.value),
          });

        if (row.value.status !== "active") return new NotOpened();

        const owner = yield* directory.profile(row.value);
        const latest = yield* transfers.latestFrom(address);

        const receipt: Option.Option<Receipt> = Option.isSome(latest)
          ? yield* Match.valueTags(latest.value, {
              Authorized: (held) =>
                reconcile(held).pipe(Effect.map(Option.some)),
              Concluded: (concluded) =>
                Effect.succeed(Option.some(concluded.receipt)),
              Proposed: () => Effect.succeed(Option.none()),
            })
          : Option.none();

        const balance = yield* readBalance(address);

        if (Option.isNone(balance)) {
          yield* directory.recover(row.value);

          return new NeedsReopening({ profile: owner });
        }

        return new Holding({
          profile: owner,
          ...(yield* portfolio(address)),
          latest: receipt,
        });
      });

      const recoverWallet = Effect.fn("Wallet.recoverWallet")(function* (
        row: WalletRow,
      ) {
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
          BigInt(current.value.sequence) + 1n ===
            BigInt(row.recoverySequence ?? "0")
        )
          yield* chain.submit(sealed).pipe(Effect.ignore);
      });

      const sweep = Effect.gen(function* () {
        const balanceIds = yield* transfers.balancesToCheck;
        const entries = yield* chain.claimable(balanceIds);

        for (const id of balanceIds) {
          if (!entries.some((entry) => entry.balance === id)) {
            const confirmed = yield* chain.claimable([id]);

            if (confirmed.length === 0) yield* transfers.closeBalance(id);
          }
        }

        const inFlight = yield* transfers.inFlight;
        const wallets = yield* directory.recoverable;
        const assetOrders = yield* assets.inFlight;

        const results = yield* Effect.forEach(
          [
            ...assetOrders.map((entry) =>
              assetActions.reconcile(entry).pipe(Effect.asVoid),
            ),
            ...inFlight.map((entry) => reconcile(entry).pipe(Effect.asVoid)),
            ...wallets.map(recoverWallet),
          ],
          (program) => program.pipe(Effect.exit),
        );

        for (const result of results) {
          if (Exit.isFailure(result))
            return yield* Effect.die(
              new Error("One or more sweep records could not be reconciled"),
            );
        }
      });

      return Wallet.of({
        manage: (order, approval) => wrap(assetActions.manage(order, approval)),
        open: (claim, approval) => wrap(open(claim, approval)),
        transfer: (order, approval) => wrap(transfer(order, approval)),
        overview: (address) => wrap(overview(address)),
        passkeyChallenge: (purpose) => wrap(backup.passkeyChallenge(purpose)),
        enroll: (enrollment) => wrap(backup.enroll(enrollment)),
        restore: (assertion) => wrap(backup.restore(assertion)),
        sweep: wrap(sweep),
      });
    }),
  );
  static readonly layer = Wallet.serviceLayer.pipe(
    Layer.provide([
      Directory.layer,
      Transfers.layer,
      AssetOrders.layer,
      Backups.layer,
      Chain.layer,
    ]),
  );
}
