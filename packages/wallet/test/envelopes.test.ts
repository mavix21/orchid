import { expect, test } from "bun:test";
import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
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
  SigningRequest,
  UnsignedEnvelope,
  formatUsdc,
  parseUsdc,
} from "../src/contract";
import { Chain, Expired, Undecided, settlementFromResponse } from "../src/server/Chain.server";
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
        new SigningRequest({ envelope, expiresAt: DateTime.makeUnsafe(expires * 1000) }),
        new Approval({ signature: holder.sign(signingPayload(envelope)) }),
        address,
      ),
    ).pipe(Effect.provide(layer)),
  );

test("money parsing preserves all seven decimals and int64 limits", () => {
  for (const value of ["0", "-1", "1e2", "1.00000001", "922337203686", "", " 1"])
    expect(Option.isNone(parseUsdc(value))).toBe(true);

  expect(formatUsdc(Option.getOrThrow(parseUsdc("5.5000001")))).toBe("5.5000001");
  expect(formatUsdc(Option.getOrThrow(parseUsdc("922337203685.4775807")))).toBe(
    "922337203685.4775807",
  );
});

test("builders and strict reader round-trip generated payment facts", () => {
  for (let i = 1; i <= 100; i++) {
    const amount = Schema.decodeSync(PositiveUsdc)(String(BigInt(i) * 1234567n));

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
    new RecoveryFacts({ address, reserveSponsor, sequence: "124", minTime: 100, maxTime: 220 }),
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

test("reader rejects memo, extra operations, wrong asset, operation source and unbounded envelopes", () => {
  const payment = Operation.payment({ destination: to, asset: usdc, amount: "1" });

  const builders = [
    new TransactionBuilder(new Account(address, "123"), {
      fee: baseFee,
      networkPassphrase,
      memo: Memo.text("unexpected"),
    }).addOperation(payment),
    new TransactionBuilder(new Account(address, "123"), { fee: baseFee, networkPassphrase })
      .addOperation(payment)
      .addOperation(payment),
    new TransactionBuilder(new Account(address, "123"), {
      fee: baseFee,
      networkPassphrase,
    }).addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount: "1" })),
    new TransactionBuilder(new Account(address, "123"), {
      fee: baseFee,
      networkPassphrase,
    }).addOperation(Operation.payment({ source: to, destination: to, asset: usdc, amount: "1" })),
    new TransactionBuilder(new Account(address, "123"), {
      fee: "200",
      networkPassphrase,
    }).addOperation(payment),
  ];

  for (const builder of builders)
    expect(
      Option.isNone(
        readEnvelope(
          Schema.decodeSync(UnsignedEnvelope)(builder.setTimebounds(100, 220).build().toXDR()),
        ),
      ),
    ).toBe(true);

  expect(Option.isNone(readEnvelope(Schema.decodeSync(UnsignedEnvelope)("not xdr")))).toBe(true);
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
  expect(Option.isNone(readEnvelope(Schema.decodeSync(UnsignedEnvelope)(sealed.envelope)))).toBe(
    true,
  );

  const invalid = await Effect.runPromise(
    Chain.use((chain) =>
      chain.seal(
        new SigningRequest({ envelope, expiresAt: DateTime.makeUnsafe((now + 120) * 1000) }),
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

  expect(settlementFromResponse(missing, sealed)).toBeInstanceOf(Expired);
  expect(
    settlementFromResponse({ ...missing, oldestLedgerCloseTime: now + 1 }, sealed),
  ).toBeInstanceOf(Undecided);
  expect(
    settlementFromResponse({ ...missing, latestLedgerCloseTime: now + 120 }, sealed),
  ).toBeInstanceOf(Undecided);
});
