import { StrKey, xdr } from "@stellar/stellar-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountAddress, Amount } from "../contract";
import { ChainUnreachable } from "./chain-errors.server";

export const LedgerEntry = Schema.Struct({
  xdr: Schema.String,
  extXdr: Schema.optional(Schema.String),
});

export type LedgerEntry = typeof LedgerEntry.Type;

const LedgerResult = Schema.Struct({
  entries: Schema.optional(Schema.Array(LedgerEntry)),
  latestLedger: Schema.Number,
});

const LedgerReply = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ result: LedgerResult }),
    Schema.Struct({
      error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
    }),
  ]),
);

export interface AccountState {
  readonly sequence: string;
  readonly nativeBalance: bigint;
  readonly balance: Option.Option<Amount>;
  readonly ledger: number;
  readonly accountSponsored: boolean;
  readonly sponsored: boolean;
}

export const fetchEntries = (
  rpcUrl: string,
  keys: ReadonlyArray<xdr.LedgerKey>,
): Effect.Effect<typeof LedgerResult.Type, ChainUnreachable> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLedgerEntries",
          params: {
            keys: [...new Set(keys.map((key) => key.toXdr("base64")))],
          },
        }),
      });

      if (!response.ok) throw new Error("Ledger RPC request failed");

      return response.text();
    },
    catch: (cause) => new ChainUnreachable({ cause }),
  }).pipe(
    Effect.map(Schema.decodeSync(LedgerReply)),
    Effect.flatMap((reply) =>
      "result" in reply
        ? Effect.succeed(reply.result)
        : Effect.fail(
            new ChainUnreachable({ cause: new Error(reply.error.message) }),
          ),
    ),
  );

export function sponsorOf(entry: LedgerEntry): Option.Option<AccountAddress> {
  if (!entry.extXdr) return Option.none();

  const extension = xdr.LedgerEntryExt.fromXDR(entry.extXdr, "base64");

  return extension.type === "v1" && extension.v1.sponsoringId !== null
    ? Schema.decodeOption(AccountAddress)(
        StrKey.encodeEd25519PublicKey(
          extension.v1.sponsoringId.ed25519.toBytes(),
        ),
      )
    : Option.none();
}

export function sponsoredBy(entry: LedgerEntry, sponsor: string): boolean {
  return Option.exists(sponsorOf(entry), (address) => address === sponsor);
}

export function accountFromEntries(
  entries: ReadonlyArray<LedgerEntry>,
  ledger: number,
  sponsor: string,
): Option.Option<AccountState> {
  const parsed = entries.map((entry) => ({
    value: xdr.LedgerEntryData.fromXDR(entry.xdr, "base64"),
    sponsored: sponsoredBy(entry, sponsor),
  }));

  const account = parsed.find((entry) => entry.value.type === "account");
  const trust = parsed.find((entry) => entry.value.type === "trustline");

  if (!account || account.value.type !== "account") return Option.none();

  return Option.some({
    sequence: account.value.value.seqNum.toString(),
    nativeBalance: account.value.value.balance,
    balance:
      trust?.value.type === "trustline"
        ? Option.some(
            Schema.decodeSync(Amount)(trust.value.value.balance.toString()),
          )
        : Option.none(),
    ledger,
    accountSponsored: account.sponsored,
    sponsored: account.sponsored && trust?.sponsored === true,
  });
}
