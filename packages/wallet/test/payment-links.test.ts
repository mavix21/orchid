import { expect, layer } from "@effect/vitest";
import {
  Claimant,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type AccountAddress,
  AssetCode,
  AssetUnsupported,
  BalanceId,
  ClaimableLimitReached,
  IssuedAsset,
  PaymentLinkRecipient,
  PositiveAmount,
  TransferOrder,
  Username,
  UsernameRecipient,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import { PaymentLinkIntent, makeWalletEffects } from "../src/device/client";
import {
  DeviceWallet,
  type KeyStore,
  PublicDeviceWallet,
} from "../src/device/key-store";
import { holdingsFromEntries } from "../src/server/ledger-assets.server";
import { transfers } from "../src/server/tables.server";
import { Transfers } from "../src/server/Transfers.server";
import { Wallet } from "../src/server/Wallet.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { networkPassphrase, usdc } from "../src/stellar/network";
import { memoryKeyStore, savedWallet } from "./device-fixtures";
import { accountEntryXdr } from "./rpc-answering";
import { SoftwareAuthenticator } from "./software-authenticator";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  amount,
  approve,
  fundedWallet,
  holdingsFor,
  orderFor,
  overviewOf,
  passkeyOrigin,
  reserveSponsor,
  send,
  settleHash,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");
const passkeys = new SoftwareAuthenticator(passkeyOrigin).passkeys;

const euro = IssuedAsset.make({
  code: Schema.decodeSync(AssetCode)("EUR"),
  issuer: addressOf(Keypair.random()),
});

const orderJson = Schema.encodeSync(Schema.fromJsonString(TransferOrder));
const walletJson = Schema.encodeSync(Schema.fromJsonString(DeviceWallet));

const publicWalletJson = Schema.encodeSync(
  Schema.fromJsonString(PublicDeviceWallet),
);

const euroLine = (
  bal: string,
  overrides: Partial<{
    readonly capacity: ReturnType<typeof amount>;
    readonly authorized: boolean;
    readonly clawbackEnabled: boolean;
  }> = {},
) => ({
  asset: euro,
  balance: amount(bal),
  spendable: amount(bal),
  capacity: overrides.capacity ?? amount("9223372036854775807"),
  authorized: overrides.authorized ?? true,
  clawbackEnabled: overrides.clawbackEnabled ?? false,
  sponsored: true,
});

const openSender = Effect.fn(function* (store: KeyStore, name = "maria") {
  const wallet = yield* Wallet;

  yield* makeWalletEffects(wallet, store, passkeys).create(name);

  const sender = yield* savedWallet(store);

  world.accounts.set(sender.address, accountState());

  return { wallet, sender };
});

const settleLinkOnSubmit =
  (wallet: WalletPort, sender: AccountAddress): WalletPort["transfer"] =>
  (order, approval) =>
    wallet.transfer(order, approval).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const sealed = world.submitted.at(-1);

          if (Option.isSome(approval) && sealed) {
            settleHash(sealed.hash);

            const parsed = TransactionBuilder.fromXDR(
              sealed.envelope,
              networkPassphrase,
            );

            const inner =
              parsed instanceof FeeBumpTransaction
                ? parsed.innerTransaction
                : parsed;

            const op = inner.operations[1];

            if (
              op?.type === "createClaimableBalance" &&
              Predicate.isTagged(order.to, "PaymentLink")
            ) {
              const balanceId = Schema.decodeSync(BalanceId)(
                inner.getClaimableBalanceId(1),
              );

              world.claimables.set(balanceId, {
                balance: balanceId,
                asset: order.asset,
                amount: order.amount,
                sponsored: true,
                claimants: [
                  new Claimant(
                    order.to.value,
                    Claimant.predicateUnconditional(),
                  ),
                  new Claimant(sender, Claimant.predicateUnconditional()),
                ],
              });
            }
          }
        }),
      ),
    );

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "the link secret never appears in requests, logs, key store or database rows",
      () =>
        Effect.gen(function* () {
          const baseStore = memoryKeyStore();
          const storeSnapshots: Array<string> = [];
          const requestPayloads: Array<string> = [];
          const logLines: Array<string> = [];

          const observingStore: KeyStore = {
            read: () => baseStore.read(),
            write: (w) =>
              baseStore.write(w).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    storeSnapshots.push(walletJson(w));
                  }),
                ),
              ),
            readPublic: () => baseStore.readPublic(),
            updatePublic: (update) =>
              baseStore.updatePublic(update).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (Option.isSome(result) && result.value.updated)
                      storeSnapshots.push(
                        publicWalletJson(result.value.wallet),
                      );
                  }),
                ),
              ),
          };

          const { wallet, sender } = yield* openSender(
            observingStore,
            "secrettest",
          );

          const settlingTransfer = settleLinkOnSubmit(wallet, sender.address);

          const observedPort: WalletPort = {
            ...wallet,
            transfer: (order, approval) =>
              Effect.sync(() => {
                requestPayloads.push(orderJson(order));
              }).pipe(Effect.andThen(settlingTransfer(order, approval))),
          };

          const captureLogger = Logger.make((options) => {
            logLines.push(String(options.message));
          });

          const created = yield* makeWalletEffects(
            observedPort,
            observingStore,
            passkeys,
          )
            .createPaymentLink(
              new PaymentLinkIntent({ asset: baseAsset, amount: linkAmount }),
            )
            .pipe(Effect.provide(Logger.layer([captureLogger])));

          assertTagged(created, "PaymentLinkCreated");
          expect(created.path).toBe(`/l/${created.address}#${created.secret}`);

          const dbRows = yield* Database.use((db) =>
            db.select().from(transfers),
          );

          const serializedRows = JSON.stringify(
            dbRows.map((row) => ({ ...row, amount: row.amount.toString() })),
          );

          expect(requestPayloads.join("\n")).not.toContain(created.secret);
          expect(logLines.join("\n")).not.toContain(created.secret);
          expect(storeSnapshots.join("\n")).not.toContain(created.secret);
          expect(serializedRows).not.toContain(created.secret);
        }),
    );

    it.effect(
      "refuses payment link creation when issuer sets AUTH_REQUIRED or source trustline enables clawback",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("flagcheck");
          const senderAddr = addressOf(sender);
          const linkAddr = addressOf(Keypair.random());

          const trustlineXdr = xdr.LedgerEntryData.trustline(
            new xdr.TrustLineEntry({
              accountId: sender.xdrPublicKey(),
              asset: usdc.toTrustLineXdrObject(),
              balance: 50_000_000n,
              limit: 1_000_000_000n,
              flags:
                xdr.TrustLineFlags.authorizedFlag.value |
                xdr.TrustLineFlags.trustlineClawbackEnabledFlag.value,
              ext: xdr.TrustLineEntryExt.v0(),
            }),
          ).toXDR("base64");

          const decoded = Option.getOrThrow(
            holdingsFromEntries(
              [
                { xdr: accountEntryXdr(sender, 1000n, 1) },
                { xdr: trustlineXdr },
              ],
              100,
              reserveSponsor,
              senderAddr,
              [baseAsset],
            ),
          );

          expect(decoded.lines[0]?.clawbackEnabled).toBe(true);
          world.holdings.set(senderAddr, decoded);

          const clawbackRefusal = yield* send(
            orderFor(sender, PaymentLinkRecipient.make({ value: linkAddr })),
          );

          expect(clawbackRefusal).toEqual(
            new AssetUnsupported({ reason: "clawback_enabled" }),
          );

          world.holdings.set(
            senderAddr,
            holdingsFor(senderAddr, { lines: [euroLine("50000000")] }),
          );
          world.issuers.set(euro.issuer, { authRequired: true });

          const authRefusal = yield* send(
            new TransferOrder({
              ...orderFor(
                sender,
                PaymentLinkRecipient.make({ value: linkAddr }),
              ),
              asset: euro,
            }),
          );

          expect(authRefusal).toEqual(
            new AssetUnsupported({ reason: "authorization_required" }),
          );
        }),
    );

    it.effect(
      "refuses the 6th open payment link while keeping username claimable quota at 2 and listing links separately",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("linkquota");
          const senderAddr = addressOf(sender);
          const recipient = yield* fundedWallet("userquota");
          const recipientAddr = addressOf(recipient);

          world.holdings.set(
            senderAddr,
            holdingsFor(senderAddr, {
              lines: [
                {
                  ...euroLine("500000000"),
                  asset: baseAsset,
                },
                euroLine("500000000"),
              ],
            }),
          );

          const createLinkAt = Effect.fn(function* (sequence: string) {
            world.accounts.set(senderAddr, accountState({ sequence }));

            const linkKey = addressOf(Keypair.random());

            const order = orderFor(
              sender,
              PaymentLinkRecipient.make({ value: linkKey }),
            );

            const draft = yield* send(order);

            assertTagged(draft, "TransferDraft");

            const facts = Option.getOrThrow(
              readEnvelope(draft.request.envelope),
            );

            assertTagged(facts, "PaymentLinkFacts");
            expect(
              (yield* send(order, approve(draft.request, sender)))._tag,
            ).toBe("Pending");

            const submitted = world.submitted.at(-1);

            if (!submitted) throw new Error("Expected submission");

            world.claimables.set(facts.balance, {
              balance: facts.balance,
              asset: baseAsset,
              amount: linkAmount,
              sponsored: true,
              claimants: [
                new Claimant(linkKey, Claimant.predicateUnconditional()),
                new Claimant(senderAddr, Claimant.predicateUnconditional()),
              ],
            });
            settleHash(submitted.hash);
            yield* sweep;

            return facts.balance;
          });

          const createdBalances = [
            yield* createLinkAt("2000"),
            yield* createLinkAt("2001"),
            yield* createLinkAt("2002"),
            yield* createLinkAt("2003"),
            yield* createLinkAt("2004"),
          ];

          world.accounts.set(senderAddr, accountState({ sequence: "2005" }));

          const sixth = yield* send(
            orderFor(
              sender,
              PaymentLinkRecipient.make({ value: addressOf(Keypair.random()) }),
            ),
          );

          expect(sixth).toEqual(new ClaimableLimitReached({ limit: 5 }));

          expect(
            yield* Transfers.use((t) =>
              t.openClaimables(senderAddr, "paymentLink"),
            ),
          ).toBe(5);
          expect(
            yield* Transfers.use((t) =>
              t.openClaimables(senderAddr, "username"),
            ),
          ).toBe(0);

          const openLinks = yield* Wallet.use((w) =>
            w.paymentLinks(senderAddr),
          );

          assertTagged(openLinks, "OpenPaymentLinks");
          expect(openLinks.links.map((l) => l.balance).sort()).toEqual(
            [...createdBalances].sort(),
          );

          const holding = yield* overviewOf(senderAddr);

          assertTagged(holding, "Holding");
          expect(holding.claimable).toEqual([]);

          const usernameClaimableAt = Effect.fn(function* (sequence: string) {
            world.accounts.set(senderAddr, accountState({ sequence }));

            const order = new TransferOrder({
              ...orderFor(
                sender,
                UsernameRecipient.make({
                  value: Schema.decodeSync(Username)("userquota"),
                }),
              ),
              asset: euro,
            });

            const draft = yield* send(order);

            assertTagged(draft, "TransferDraft");

            const facts = Option.getOrThrow(
              readEnvelope(draft.request.envelope),
            );

            assertTagged(facts, "ClaimableFacts");
            expect(
              (yield* send(order, approve(draft.request, sender)))._tag,
            ).toBe("Pending");

            const submitted = world.submitted.at(-1);

            if (!submitted) throw new Error("Expected submission");

            world.claimables.set(facts.balance, {
              balance: facts.balance,
              asset: euro,
              amount: linkAmount,
              sponsored: true,
              claimants: [
                new Claimant(recipientAddr, Claimant.predicateUnconditional()),
                new Claimant(
                  senderAddr,
                  Claimant.predicateNot(
                    Claimant.predicateBeforeAbsoluteTime("9999999999"),
                  ),
                ),
              ],
            });
            settleHash(submitted.hash);
            yield* sweep;
          });

          yield* usernameClaimableAt("2006");
          yield* usernameClaimableAt("2007");

          world.accounts.set(senderAddr, accountState({ sequence: "2008" }));

          const thirdUsername = yield* send(
            new TransferOrder({
              ...orderFor(
                sender,
                UsernameRecipient.make({
                  value: Schema.decodeSync(Username)("userquota"),
                }),
              ),
              asset: euro,
            }),
          );

          expect(thirdUsername).toEqual(
            new ClaimableLimitReached({ limit: 2 }),
          );
        }),
    );
  },
);
