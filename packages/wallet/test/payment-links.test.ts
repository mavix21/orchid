import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair, xdr } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssetUnsupported,
  ClaimableLimitReached,
  PaymentLinkRecipient,
  PositiveAmount,
  TransferOrder,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import {
  PasskeyCancelled,
  PaymentLinkIntent,
  makeWalletEffects,
} from "../src/device/client";
import type { PublicDeviceWallet } from "../src/device/key-store";
import { holdingsFromEntries } from "../src/server/ledger-assets.server";
import { transfers } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { usdc } from "../src/stellar/network";
import { memoryKeyStore } from "./device-fixtures";
import {
  approvingDevice,
  installSealedWallet,
  sealedKeyStore,
  storedEntry,
  storedKeys,
} from "./sealed-wallet-fixtures";
import { accountEntryXdr } from "./rpc-answering";
import { assertTagged } from "./tagged";
import {
  accountState,
  addressOf,
  approve,
  devicePasskeys,
  euro,
  euroLine,
  fundedWallet,
  holdingsFor,
  openSender,
  orderFor,
  reserveSponsor,
  send,
  settleHash,
  settleOnSubmit,
  sweep,
  useDisposableDatabase,
  walletTestLayer,
  world,
} from "./wallet-harness";

const linkAmount = Schema.decodeSync(PositiveAmount)("10000000");
const orderJson = Schema.encodeSync(Schema.fromJsonString(TransferOrder));

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "funds a link only through a confirmed passkey approval that commits its receipt first, and never exposes the secret",
      () =>
        Effect.gen(function* () {
          const requestPayloads: Array<string> = [];
          const storeSnapshots: Array<string> = [];
          const logLines: Array<string> = [];
          const released: Array<PublicDeviceWallet> = [];

          const { wallet, sender } = yield* openSender(
            memoryKeyStore(),
            "secrettest",
          );

          const { auth } = yield* installSealedWallet(sender);
          const settlingTransfer = settleOnSubmit(wallet, sender.address);

          const rawEntries = Effect.promise(async () =>
            JSON.stringify(
              await Promise.all(
                (await storedKeys()).map((key) => storedEntry(String(key))),
              ),
            ),
          );

          const observedPort: WalletPort = {
            ...wallet,
            transfer: (order, approval) =>
              Effect.gen(function* () {
                requestPayloads.push(orderJson(order));
                storeSnapshots.push(yield* rawEntries);

                if (Option.isSome(approval))
                  released.push(
                    Option.getOrThrow(
                      yield* Effect.orDie(sealedKeyStore.readPublic()),
                    ),
                  );

                return yield* settlingTransfer(order, approval);
              }),
          };

          const captureLogger = Logger.make((options) => {
            logLines.push(String(options.message));
          });

          const client = makeWalletEffects(
            observedPort,
            sealedKeyStore,
            devicePasskeys,
            approvingDevice(auth),
          );

          const review = yield* client
            .reviewPaymentLink(
              new PaymentLinkIntent({ asset: baseAsset, amount: linkAmount }),
            )
            .pipe(Effect.provide(Logger.layer([captureLogger])));

          assertTagged(review, "PaymentReview");

          auth.cancels = true;

          expect(yield* client.confirmPaymentLink(review)).toEqual(
            new PasskeyCancelled(),
          );
          expect(released).toEqual([]);

          const withheld = Option.getOrThrow(
            yield* sealedKeyStore.readPublic(),
          );

          expect(withheld.approvedUntil).toBeUndefined();
          expect(withheld.linkReceipt).toBeUndefined();

          auth.cancels = false;

          const created = yield* client
            .confirmPaymentLink(review)
            .pipe(Effect.provide(Logger.layer([captureLogger])));

          assertTagged(created, "PaymentLinkCreated");
          expect(created.path).toBe(`/l/${created.address}#${created.secret}`);
          expect(
            released.map(({ approvedUntil, linkReceipt }) => ({
              approved: approvedUntil !== undefined,
              link: linkReceipt?.address,
              balance: linkReceipt?.balance,
            })),
          ).toEqual([
            { approved: true, link: created.address, balance: created.balance },
          ]);

          storeSnapshots.push(yield* rawEntries);

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
      "refuses the 6th open payment link and lists the five open links",
      () =>
        Effect.gen(function* () {
          const sender = yield* fundedWallet("linkquota");
          const senderAddr = addressOf(sender);

          world.holdings.set(
            senderAddr,
            holdingsFor(senderAddr, {
              lines: [{ ...euroLine("500000000"), asset: baseAsset }],
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

          const openLinks = yield* Wallet.use((w) =>
            w.paymentLinks(senderAddr),
          );

          assertTagged(openLinks, "OpenPaymentLinks");
          expect(openLinks.links.map((l) => l.balance).sort()).toEqual(
            [...createdBalances].sort(),
          );
        }),
    );
  },
);
