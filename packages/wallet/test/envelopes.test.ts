import { expect, test } from "bun:test";
import {
  FeeBumpTransaction,
  xdr,
  Account,
  Asset,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Approval,
  PositiveUsdc,
  PaymentMemo,
  SigningRequest,
  UnsignedEnvelope,
  formatUsdc,
  parseUsdc,
} from "../src/contract";
import {
  Applied,
  Chain,
  Expired,
  Rejected,
  Undecided,
  settlementFromResponse,
  resolveSettlement,
  type SettlementReader,
} from "../src/server/Chain.server";
import { accountFromEntries } from "../src/server/ledger.server";
import { WalletSettings } from "../src/server/settings.server";
import {
  OpeningFacts,
  PaymentFacts,
  RecoveryFacts,
  draftOpening,
  draftPayment,
  draftRecovery,
  readEnvelope,
  signingPayload,
} from "../src/stellar/envelopes";
import { baseFee, networkPassphrase, usdc } from "../src/stellar/network";
import { rpc } from "@stellar/stellar-sdk";

const holder = Keypair.random();
const sponsor = Keypair.random();
const feePayer = Keypair.random();
const address = Schema.decodeSync(AccountAddress)(holder.publicKey());
const reserveSponsor = Schema.decodeSync(AccountAddress)(sponsor.publicKey());
const to = Schema.decodeSync(AccountAddress)(Keypair.random().publicKey());

const layer = Chain.layer.pipe(
  Layer.provide(
    Layer.succeed(WalletSettings, {
      rpcUrl: "https://soroban-testnet.stellar.org",
      reserveSponsorSecret: Redacted.make(sponsor.secret()),
      feePayerSecret: Redacted.make(feePayer.secret()),
    }),
  ),
);

const seal = (envelope: UnsignedEnvelope, expires: number) =>
  Effect.runPromise(
    Chain.use((chain) =>
      chain.seal(
        new SigningRequest({
          envelope,
          expiresAt: DateTime.makeUnsafe(expires * 1000),
        }),
        new Approval({ signature: holder.sign(signingPayload(envelope)) }),
        address,
      ),
    ).pipe(Effect.provide(layer)),
  );

test("money parsing preserves all seven decimals and int64 limits", () => {
  for (const value of [
    "0",
    "-1",
    "1e2",
    "1.00000001",
    "922337203686",
    "",
    " 1",
  ])
    expect(Option.isNone(parseUsdc(value))).toBe(true);

  expect(formatUsdc(Option.getOrThrow(parseUsdc("5.5000001")))).toBe(
    "5.5000001",
  );
  expect(formatUsdc(Option.getOrThrow(parseUsdc("922337203685.4775807")))).toBe(
    "922337203685.4775807",
  );
});

test("builders and strict reader round-trip generated payment facts", () => {
  for (let i = 1; i <= 100; i++) {
    const amount = Schema.decodeSync(PositiveUsdc)(
      String(BigInt(i) * 1234567n),
    );

    const envelope = draftPayment({
      source: new Account(address, String(i)),
      to,
      amount,
      minTime: 100,
      maxTime: 220,
    });

    const facts = Option.getOrThrow(readEnvelope(envelope));

    expect(facts).toBeInstanceOf(PaymentFacts);
    expect(facts).toEqual(
      new PaymentFacts({
        from: address,
        to,
        amount,
        sequence: String(i + 1),
        minTime: 100,
        maxTime: 220,
      }),
    );
    expect(signingPayload(envelope).length).toBe(32);
  }
});

test("opening supports exactly the creation and trustline-repair sandwiches", () => {
  for (const createAccount of [true, false]) {
    const envelope = draftOpening({
      source: new Account(reserveSponsor, "123"),
      address,
      createAccount,
      minTime: 100,
      maxTime: 220,
    });

    expect(Option.getOrThrow(readEnvelope(envelope))).toEqual(
      new OpeningFacts({
        address,
        reserveSponsor,
        createAccount,
        sequence: "124",
        minTime: 100,
        maxTime: 220,
      }),
    );
  }
});

test("recovery contains bounded next-sequence trustline removal and merge", () => {
  const envelope = draftRecovery({
    source: new Account(address, "123"),
    reserveSponsor,
    minTime: 100,
    maxTime: 220,
  });

  expect(Option.getOrThrow(readEnvelope(envelope))).toEqual(
    new RecoveryFacts({
      address,
      reserveSponsor,
      sequence: "124",
      minTime: 100,
      maxTime: 220,
    }),
  );
  expect(
    Option.isNone(
      readEnvelope(
        draftRecovery({
          source: new Account(address, "123"),
          reserveSponsor,
          minTime: 100,
          maxTime: 0,
        }),
      ),
    ),
  ).toBe(true);
});

test("reader rejects unsupported memos, extra operations, wrong asset, operation source and unbounded envelopes", () => {
  const payment = Operation.payment({
    destination: to,
    asset: usdc,
    amount: "1",
  });

  const builders = [
    new TransactionBuilder(new Account(address, "123"), {
      fee: baseFee,
      networkPassphrase,
      memo: Memo.hash(new Uint8Array(32)),
    }).addOperation(payment),
    new TransactionBuilder(new Account(address, "123"), {
      fee: baseFee,
      networkPassphrase,
    })
      .addOperation(payment)
      .addOperation(payment),
    new TransactionBuilder(new Account(address, "123"), {
      fee: baseFee,
      networkPassphrase,
    }).addOperation(
      Operation.payment({
        destination: to,
        asset: Asset.native(),
        amount: "1",
      }),
    ),
    new TransactionBuilder(new Account(address, "123"), {
      fee: baseFee,
      networkPassphrase,
    }).addOperation(
      Operation.payment({
        source: to,
        destination: to,
        asset: usdc,
        amount: "1",
      }),
    ),
    new TransactionBuilder(new Account(address, "123"), {
      fee: "200",
      networkPassphrase,
    }).addOperation(payment),
  ];

  for (const builder of builders)
    expect(
      Option.isNone(
        readEnvelope(
          Schema.decodeSync(UnsignedEnvelope)(
            builder.setTimebounds(100, 220).build().toXDR(),
          ),
        ),
      ),
    ).toBe(true);

  expect(
    Option.isNone(readEnvelope(Schema.decodeSync(UnsignedEnvelope)("not xdr"))),
  ).toBe(true);
});

test("seal verifies the holder and uses a distinct fee payer without modifying the draft", async () => {
  const now = Math.floor(Date.now() / 1000);

  const envelope = draftOpening({
    source: new Account(reserveSponsor, "123"),
    address,
    createAccount: true,
    minTime: now,
    maxTime: now + 120,
  });

  const sealed = await seal(envelope, now + 120);
  const outer = TransactionBuilder.fromXDR(sealed.envelope, networkPassphrase);

  expect("feeSource" in outer && outer.feeSource).toBe(feePayer.publicKey());
  expect(Option.isSome(readEnvelope(envelope))).toBe(true);
  expect(
    Option.isNone(
      readEnvelope(Schema.decodeSync(UnsignedEnvelope)(sealed.envelope)),
    ),
  ).toBe(true);

  const invalid = await Effect.runPromise(
    Chain.use((chain) =>
      chain.seal(
        new SigningRequest({
          envelope,
          expiresAt: DateTime.makeUnsafe((now + 120) * 1000),
        }),
        new Approval({ signature: new Uint8Array(64) }),
        address,
      ),
    ).pipe(Effect.result, Effect.provide(layer)),
  );

  expect(Result.isFailure(invalid)).toBe(true);
});

test("NOT_FOUND only proves expiry when RPC history covers the inclusion window", async () => {
  const now = Math.floor(Date.now() / 1000);

  const envelope = draftPayment({
    source: new Account(address, "123"),
    to,
    amount: Schema.decodeSync(PositiveUsdc)("1"),
    minTime: now,
    maxTime: now + 120,
  });

  const sealed = await seal(envelope, now + 120);

  const missing: rpc.Api.GetMissingTransactionResponse = {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    txHash: sealed.hash,
    latestLedger: 100,
    latestLedgerCloseTime: now + 121,
    oldestLedger: 1,
    oldestLedgerCloseTime: now - 1,
  };

  expect(
    settlementFromResponse(
      missing,
      sealed,
      Option.some({
        sequence: "123",
        nativeBalance: 0n,
        balance: Option.none(),
        ledger: 100,
        accountSponsored: true,
        sponsored: true,
      }),
    ),
  ).toBeInstanceOf(Expired);
  expect(
    settlementFromResponse(
      { ...missing, oldestLedgerCloseTime: now + 1 },
      sealed,
      Option.some({
        sequence: "123",
        nativeBalance: 0n,
        balance: Option.none(),
        ledger: 100,
        accountSponsored: true,
        sponsored: true,
      }),
    ),
  ).toBeInstanceOf(Undecided);
  expect(
    settlementFromResponse(
      { ...missing, latestLedgerCloseTime: now + 120 },
      sealed,
      Option.some({
        sequence: "123",
        nativeBalance: 0n,
        balance: Option.none(),
        ledger: 100,
        accountSponsored: true,
        sponsored: true,
      }),
    ),
  ).toBeInstanceOf(Undecided);
});

test("consumed sequence only concludes with complete inner-hash absence evidence", async () => {
  const now = Math.floor(Date.now() / 1000);

  const envelope = draftPayment({
    source: new Account(address, "123"),
    to,
    amount: Schema.decodeSync(PositiveUsdc)("1"),
    minTime: now,
    maxTime: now + 120,
  });

  const sealed = await seal(envelope, now + 120);
  const queried = new Array<string>();

  const reader: SettlementReader = {
    transaction: (hash) => {
      queried.push(hash);

      return Effect.succeed({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: hash,
        latestLedger: 100,
        latestLedgerCloseTime: now + 121,
        oldestLedger: 1,
        oldestLedgerCloseTime: now - 1,
      });
    },
    account: () =>
      Effect.succeed(
        Option.some({
          sequence: "124",
          nativeBalance: 0n,
          balance: Option.none(),
          ledger: 100,
          accountSponsored: true,
          sponsored: true,
        }),
      ),
  };

  expect(await Effect.runPromise(resolveSettlement(sealed, reader))).toEqual(
    new Rejected({ code: "sequence_consumed" }),
  );
  expect(queried).toEqual([
    sealed.hash,
    ...Array.from({ length: 2 }, () =>
      Array.from(signingPayload(envelope), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  ]);

  const outsideHistory: SettlementReader = {
    ...reader,
    transaction: (hash: string) =>
      Effect.succeed({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: hash,
        latestLedger: 100,
        latestLedgerCloseTime: now + 121,
        oldestLedger: 90,
        oldestLedgerCloseTime: now + 1,
      }),
  };

  expect(
    await Effect.runPromise(resolveSettlement(sealed, outsideHistory)),
  ).toBeInstanceOf(Undecided);

  const behind: SettlementReader = {
    ...reader,
    transaction: (hash: string) =>
      Effect.succeed({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: hash,
        latestLedger: 99,
        latestLedgerCloseTime: now + 121,
        oldestLedger: 1,
        oldestLedgerCloseTime: now - 1,
      }),
  };

  expect(
    await Effect.runPromise(resolveSettlement(sealed, behind)),
  ).toBeInstanceOf(Undecided);

  const absent = {
    ...reader,
    account: () =>
      Effect.succeed(
        Option.some({
          sequence: "123",
          nativeBalance: 0n,
          balance: Option.none(),
          ledger: 100,
          accountSponsored: true,
          sponsored: true,
        }),
      ),
  };

  expect(
    await Effect.runPromise(resolveSettlement(sealed, absent)),
  ).toBeInstanceOf(Expired);

  const stale = {
    ...absent,
    account: () =>
      Effect.succeed(
        Option.some({
          sequence: "123",
          nativeBalance: 0n,
          balance: Option.none(),
          ledger: 99,
          accountSponsored: true,
          sponsored: true,
        }),
      ),
  };

  expect(
    await Effect.runPromise(resolveSettlement(sealed, stale)),
  ).toBeInstanceOf(Undecided);
});

test("settlement discovers the same inner transaction under a different fee payer", async () => {
  const now = Math.floor(Date.now() / 1000);

  const envelope = draftPayment({
    source: new Account(address, "123"),
    to,
    amount: Schema.decodeSync(PositiveUsdc)("1"),
    minTime: now,
    maxTime: now + 120,
  });

  const sealed = await seal(envelope, now + 120);

  const original = TransactionBuilder.fromXDR(
    sealed.envelope,
    networkPassphrase,
  );

  if (!(original instanceof FeeBumpTransaction))
    throw new Error("Expected fee bump");

  const other = Keypair.random();

  const replacement = TransactionBuilder.buildFeeBumpTransaction(
    other.publicKey(),
    baseFee,
    original.innerTransaction,
    networkPassphrase,
  );

  replacement.sign(other);

  const applied: rpc.Api.GetSuccessfulTransactionResponse = {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    txHash: "alternate fee bump",
    latestLedger: 100,
    latestLedgerCloseTime: now + 121,
    oldestLedger: 1,
    oldestLedgerCloseTime: now - 1,
    ledger: 90,
    createdAt: now + 20,
    applicationOrder: 1,
    feeBump: true,
    envelopeXdr: replacement.toEnvelope(),
    resultXdr: new xdr.TransactionResult({
      feeCharged: 200n,
      result: xdr.TransactionResultResult.txSuccess([]),
      ext: xdr.TransactionResultExt.v0(),
    }),
    resultMetaXdr: xdr.TransactionMeta.operations([]),
    events: { contractEventsXdr: [], transactionEventsXdr: [] },
  };

  const reader: SettlementReader = {
    transaction: (hash) =>
      Effect.succeed(
        hash === sealed.hash
          ? {
              status: rpc.Api.GetTransactionStatus.NOT_FOUND,
              txHash: hash,
              latestLedger: 100,
              latestLedgerCloseTime: now + 121,
              oldestLedger: 1,
              oldestLedgerCloseTime: now - 1,
            }
          : applied,
      ),
    account: () =>
      Effect.die("A confirmed inner result needs no sequence inference"),
  };

  expect(await Effect.runPromise(resolveSettlement(sealed, reader))).toEqual(
    new Applied({ at: DateTime.makeUnsafe((now + 20) * 1000) }),
  );
});

test("recovery sponsorship requires matching account and trustline sponsors, not sponsored counts", () => {
  const account = xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: holder.xdrPublicKey(),
      balance: 0n,
      seqNum: 123n,
      numSubEntries: 1,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: new Uint8Array([1, 0, 0, 0]),
      signers: [],
      ext: xdr.AccountEntryExt.v0(),
    }),
  ).toXDR("base64");

  const trust = xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: holder.xdrPublicKey(),
      asset: usdc.toTrustLineXdrObject(),
      balance: 0n,
      limit: 9223372036854775807n,
      flags: 1,
      ext: xdr.TrustLineEntryExt.v0(),
    }),
  ).toXDR("base64");

  const extension = (key: Keypair) =>
    xdr.LedgerEntryExt.v1(
      new xdr.LedgerEntryExtensionV1({
        sponsoringId: key.xdrPublicKey(),
        ext: xdr.LedgerEntryExtensionV1Ext.v0(),
      }),
    ).toXDR("base64");

  const owned = [
    { xdr: account, extXdr: extension(sponsor) },
    { xdr: trust, extXdr: extension(sponsor) },
  ];

  expect(
    Option.getOrThrow(accountFromEntries(owned, 100, reserveSponsor)).sponsored,
  ).toBe(true);
  expect(
    Option.getOrThrow(
      accountFromEntries(
        [{ xdr: account }, { xdr: trust }],
        100,
        reserveSponsor,
      ),
    ).sponsored,
  ).toBe(false);
  expect(
    Option.getOrThrow(
      accountFromEntries(
        [{ xdr: account, extXdr: extension(feePayer) }, owned[1]],
        100,
        reserveSponsor,
      ),
    ).accountSponsored,
  ).toBe(false);
  expect(
    Option.getOrThrow(
      accountFromEntries(
        [owned[0], { xdr: trust, extXdr: extension(feePayer) }],
        100,
        reserveSponsor,
      ),
    ).sponsored,
  ).toBe(false);
});

test("text and id memos validate at the boundary and survive reading and sealing", async () => {
  const now = Math.floor(Date.now() / 1000);

  for (const memo of [
    { type: "text", value: "exchange dépôt 🪷" },
    { type: "text", value: "\uFEFFdeposit" },
    { type: "id", value: "18446744073709551615" },
    { type: "id", value: "0" },
  ]) {
    const checked = Schema.decodeUnknownSync(PaymentMemo)(memo);

    const envelope = draftPayment({
      source: new Account(address, "123"),
      to,
      amount: Schema.decodeSync(PositiveUsdc)("1"),
      minTime: now,
      maxTime: now + 120,
      memo: checked,
    });

    const facts = Option.getOrThrow(readEnvelope(envelope));

    if (!(facts instanceof PaymentFacts)) throw new Error("Expected payment");

    expect(facts.memo).toEqual(checked);

    const sealed = await seal(envelope, now + 120);

    const outer = TransactionBuilder.fromXDR(
      sealed.envelope,
      networkPassphrase,
    );

    if (!(outer instanceof FeeBumpTransaction))
      throw new Error("Expected fee bump");

    expect(outer.innerTransaction.memo.toXdrObject().toXDR("base64")).toBe(
      (checked.type === "text"
        ? Memo.text(checked.value)
        : Memo.id(checked.value)
      )
        .toXdrObject()
        .toXDR("base64"),
    );
  }

  for (const memo of [
    { type: "text", value: "" },
    { type: "text", value: "é".repeat(15) },
    { type: "text", value: "\uD800" },
    { type: "id", value: "18446744073709551616" },
    { type: "id", value: "-1" },
    { type: "id", value: "01" },
    { type: "id", value: "1e3" },
    { type: "hash", value: "abc" },
  ])
    expect(Option.isNone(Schema.decodeUnknownOption(PaymentMemo)(memo))).toBe(
      true,
    );
});
