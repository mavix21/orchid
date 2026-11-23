import { expect, layer } from "@effect/vitest";
import { Claimant, Keypair, xdr } from "@stellar/stellar-sdk";
import { Database } from "@workspace/db";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Approval,
  AssetUnsupported,
  BalanceId,
  ClaimableLimitReached,
  OpenPaymentLink,
  OpenPaymentLinks,
  PaymentLinkRecipient,
  PositiveAmount,
  TransferOrder,
  type WalletPort,
  baseAsset,
} from "../src/contract";
import type { AssertionCeremony } from "../src/device/assertion";
import { browserKeyStore } from "../src/device/browser-key-store";
import {
  LinkOutputMissing,
  PasskeyCancelled,
  PaymentLinkIntent,
  makeWalletEffects,
} from "../src/device/client";
import type { PublicDeviceWallet } from "../src/device/key-store";
import { SealedLinkSecret, linkPrfInput } from "../src/device/link-seal";
import { holdingsFromEntries } from "../src/server/ledger-assets.server";
import { transfers } from "../src/server/tables.server";
import { Wallet } from "../src/server/Wallet.server";
import { readEnvelope } from "../src/stellar/envelopes";
import { network, usdc } from "../src/stellar/network";
import { memoryKeyStore } from "./device-fixtures";
import {
  approvingDevice,
  installSealedWallet,
  putRawEntry,
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

interface ReleasedState {
  readonly wallet: PublicDeviceWallet;
  readonly links: ReadonlyArray<SealedLinkSecret>;
}

const orderJson = Schema.encodeSync(Schema.fromJsonString(TransferOrder));

useDisposableDatabase();

layer(walletTestLayer, { excludeTestServices: true, concurrent: false })(
  (it) => {
    it.effect(
      "funds a saved link only through a confirmed passkey approval that commits its receipt and envelope first, re-shares it and never exposes the secret",
      () =>
        Effect.gen(function* () {
          const requestPayloads: Array<string> = [];
          const storeSnapshots: Array<string> = [];
          const logLines: Array<string> = [];
          const released: Array<ReleasedState> = [];
          let listed: ReadonlyArray<OpenPaymentLink> = [];

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
                  released.push({
                    wallet: Option.getOrThrow(
                      yield* Effect.orDie(sealedKeyStore.readPublic()),
                    ),
                    links: yield* Effect.orDie(browserKeyStore.readLinks()),
                  });

                return yield* settlingTransfer(order, approval);
              }),
            paymentLinks: (address) =>
              Effect.sync(() => {
                requestPayloads.push(address);

                return new OpenPaymentLinks({ links: listed });
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
              new PaymentLinkIntent({
                asset: baseAsset,
                amount: linkAmount,
                saveOnDevice: true,
              }),
            )
            .pipe(Effect.provide(Logger.layer([captureLogger])));

          assertTagged(review, "PaymentReview");

          auth.cancels = true;

          expect(yield* client.confirmPaymentLink(review)).toEqual(
            new PasskeyCancelled(),
          );
          expect(released).toEqual([]);
          expect(yield* browserKeyStore.readLinks()).toEqual([]);

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
          expect(created.savedOnDevice).toBe(true);

          const linkInput = yield* linkPrfInput({
            network,
            wallet: sender.address,
            address: created.address,
          });

          expect(
            Option.map(auth.requested.at(-1) ?? Option.none(), (inputs) =>
              Option.getOrUndefined(inputs.second),
            ),
          ).toEqual(Option.some(linkInput));
          expect(
            released.map(({ wallet: state, links }) => ({
              approved: state.approvedUntil !== undefined,
              link: state.linkReceipt?.address,
              balance: state.linkReceipt?.balance,
              saved: links.map((link) => link.address),
            })),
          ).toEqual([
            {
              approved: true,
              link: created.address,
              balance: created.balance,
              saved: [created.address],
            },
          ]);

          const [savedLink] = yield* browserKeyStore.readLinks();

          expect(savedLink?.fundedBalance).toBe(created.balance);

          const ciphertext = Schema.encodeSync(SealedLinkSecret)(
            Option.getOrThrow(Option.fromNullishOr(savedLink)),
          ).ciphertext;

          const target = {
            address: created.address,
            balance: created.balance,
            asset: created.asset,
            amount: created.amount,
          };

          yield* Effect.promise(async () =>
            putRawEntry("payment-links", [
              { version: 1, address: "corrupt" },
              ...Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
                await storedEntry("payment-links"),
              ),
            ]),
          );

          const revealed = yield* client.revealPaymentLink(target);

          assertTagged(revealed, "PaymentLinkRevealed");
          expect(revealed.path).toBe(created.path);
          expect(auth.requested.at(-1)).toEqual(
            Option.some({ first: linkInput, second: Option.none() }),
          );

          listed = [
            new OpenPaymentLink({
              id: created.id,
              ...target,
              createdAt: created.settledAt,
            }),
            new OpenPaymentLink({
              id: created.id,
              balance: Schema.decodeSync(BalanceId)(
                `00000000${"7".repeat(64)}`,
              ),
              address: addressOf(Keypair.random()),
              asset: baseAsset,
              amount: linkAmount,
              createdAt: created.settledAt,
            }),
          ];

          const annotated = yield* client.paymentLinks();

          assertTagged(annotated, "ListedPaymentLinks");
          expect(annotated.links.map((link) => link.savedOnDevice)).toEqual([
            true,
            false,
          ]);

          listed = [];
          assertTagged(yield* client.paymentLinks(), "ListedPaymentLinks");
          expect(
            (yield* browserKeyStore.readLinks()).map((link) => link.address),
          ).toEqual([created.address]);

          storeSnapshots.push(yield* rawEntries);

          const dbRows = yield* Database.use((db) =>
            db.select().from(transfers),
          );

          const serializedRows = JSON.stringify(
            dbRows.map((row) => ({ ...row, amount: row.amount.toString() })),
          );

          const exposed = [
            requestPayloads.join("\n"),
            logLines.join("\n"),
            serializedRows,
          ].join("\n");

          expect(exposed).not.toContain(created.secret);
          expect(exposed).not.toContain(ciphertext);
          expect(storeSnapshots.join("\n")).not.toContain(created.secret);
        }),
    );

    it.effect(
      "stops saved funding when only the link output is missing and funds a separately reviewed one-time link",
      () =>
        Effect.gen(function* () {
          const released: Array<Approval> = [];

          const { wallet, sender } = yield* openSender(
            memoryKeyStore(),
            "onetimelink",
          );

          const { auth } = yield* installSealedWallet(sender);
          const settlingTransfer = settleOnSubmit(wallet, sender.address);

          const ceremony: AssertionCeremony = {
            assert: (request) =>
              auth.assertions.assert(request).pipe(
                Effect.map((platform) => ({
                  ...platform,
                  prf: { ...platform.prf, second: Option.none() },
                })),
              ),
          };

          const client = makeWalletEffects(
            {
              ...wallet,
              transfer: (order, approval) => {
                released.push(...Option.toArray(approval));

                return settlingTransfer(order, approval);
              },
            },
            sealedKeyStore,
            devicePasskeys,
            { ...approvingDevice(auth), ceremony },
          );

          const intent = (saveOnDevice: boolean) =>
            new PaymentLinkIntent({
              asset: baseAsset,
              amount: linkAmount,
              saveOnDevice,
            });

          const saved = yield* client.reviewPaymentLink(intent(true));

          assertTagged(saved, "PaymentReview");
          expect(yield* client.confirmPaymentLink(saved)).toEqual(
            new LinkOutputMissing(),
          );
          expect(released).toEqual([]);

          const withheld = Option.getOrThrow(
            yield* sealedKeyStore.readPublic(),
          );

          expect(withheld.approvedUntil).toBeUndefined();
          expect(withheld.linkReceipt).toBeUndefined();

          const once = yield* client.reviewPaymentLink(intent(false));

          assertTagged(once, "PaymentReview");

          const created = yield* client.confirmPaymentLink(once);

          assertTagged(created, "PaymentLinkCreated");
          expect(created.savedOnDevice).toBe(false);
          expect(released).toHaveLength(1);
          expect(
            Option.map(auth.requested.at(-1) ?? Option.none(), (inputs) =>
              Option.isSome(inputs.second),
            ),
          ).toEqual(Option.some(false));
          expect(yield* browserKeyStore.readLinks()).toEqual([]);
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
