import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Amount } from "../contract";

export const LedgerEntry = Schema.Struct({
  xdr: Schema.String,
  extXdr: Schema.optional(Schema.String),
});

export type LedgerEntry = typeof LedgerEntry.Type;

export const LedgerResponse = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      entries: Schema.optional(Schema.Array(LedgerEntry)),
      latestLedger: Schema.Number,
    }),
  }),
);

export interface AccountState {
  readonly sequence: string;
  readonly nativeBalance: bigint;
  readonly balance: Option.Option<Amount>;
  readonly ledger: number;
  readonly accountSponsored: boolean;
  readonly sponsored: boolean;
}

export async function fetchEntries(
  rpcUrl: string,
  keys: ReadonlyArray<xdr.LedgerKey>,
): Promise<typeof LedgerResponse.Type.result> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLedgerEntries",
      params: { keys: keys.map((key) => key.toXdr("base64")) },
    }),
  });

  if (!response.ok) throw new Error("Ledger RPC request failed");

  return Schema.decodeSync(LedgerResponse)(await response.text()).result;
}

export function sponsoredBy(entry: LedgerEntry, sponsor: string): boolean {
  if (!entry.extXdr) return false;

  const extension = xdr.LedgerEntryExt.fromXDR(entry.extXdr, "base64");

  return (
    extension.type === "v1" &&
    extension.v1.sponsoringId !== null &&
    extension.v1.sponsoringId.toXDR("base64") ===
      Keypair.fromPublicKey(sponsor).xdrPublicKey().toXDR("base64")
  );
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
