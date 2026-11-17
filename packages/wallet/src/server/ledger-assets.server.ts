import {
  Asset as StellarAsset,
  Claimant as StellarClaimant,
  Keypair,
  xdr,
} from "@stellar/stellar-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AccountAddress,
  Amount,
  type Asset,
  BalanceId,
  type IssuedAsset,
  PositiveAmount,
} from "../contract";
import { fromStellarAsset, toStellarAsset } from "../stellar/assets";
import { baseReserve, usdc } from "../stellar/network";
import {
  type AccountState,
  type LedgerEntry,
  accountFromEntries,
  sponsoredBy,
} from "./ledger.server";

export interface Line {
  readonly asset: IssuedAsset;
  readonly balance: Amount;
  /** The balance minus what open offers already commit to selling. */
  readonly spendable: Amount;
  readonly authorized: boolean;
  /** Its reserve is carried by the configured reserve sponsor. */
  readonly sponsored: boolean;
}

/** The counters behind an account's minimum balance. */
export interface Reserves {
  readonly subentries: number;
  readonly sponsored: number;
  readonly sponsoring: number;
}

export interface Holdings {
  readonly account: AccountState;
  /** XLM above the minimum balance and selling liabilities. */
  readonly native: Amount;
  readonly reserves: Reserves;
  /** The requested trustlines that exist. */
  readonly lines: ReadonlyArray<Line>;
}

export interface Issuer {
  readonly authRequired: boolean;
}

export interface ClaimableEntry {
  readonly balance: BalanceId;
  readonly asset: Asset;
  readonly amount: PositiveAmount;
  readonly claimants: ReadonlyArray<StellarClaimant>;
  readonly sponsored: boolean;
}

export const accountKey = (address: AccountAddress) =>
  xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
    }),
  );

export const lineKey = (address: AccountAddress, asset: StellarAsset) =>
  xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: asset.toTrustLineXdrObject(),
    }),
  );

export const balanceKey = (balance: BalanceId) =>
  xdr.LedgerKey.claimableBalance(
    new xdr.LedgerKeyClaimableBalance({
      balanceId: xdr.ClaimableBalanceId.fromXdr(balance, "hex"),
    }),
  );

const parse = (entries: ReadonlyArray<LedgerEntry>) =>
  entries.map((raw) => ({
    raw,
    data: xdr.LedgerEntryData.fromXdr(raw.xdr, "base64"),
  }));

const owns = (address: AccountAddress, accountId: xdr.PublicKey) =>
  accountId.equals(Keypair.fromPublicKey(address).xdrPublicKey());

const amountOf = (value: bigint) =>
  Schema.decodeSync(Amount)((value < 0n ? 0n : value).toString());

function reservesOf(account: xdr.AccountEntry): Reserves & {
  readonly selling: bigint;
} {
  const v1 = account.ext.type === "v1" ? account.ext.v1 : undefined;
  const v2 = v1?.ext.type === "v2" ? v1.ext.v2 : undefined;

  return {
    subentries: account.numSubEntries,
    sponsored: v2?.numSponsored ?? 0,
    sponsoring: v2?.numSponsoring ?? 0,
    selling: v1?.liabilities.selling ?? 0n,
  };
}

/**
 * Reads one account and the requested trustlines out of a getLedgerEntries
 * answer that may also hold other accounts' entries.
 */
export function holdingsFromEntries(
  entries: ReadonlyArray<LedgerEntry>,
  ledger: number,
  sponsor: string,
  address: AccountAddress,
  assets: ReadonlyArray<IssuedAsset>,
): Option.Option<Holdings> {
  const own = parse(entries).filter(
    ({ data }) =>
      (data.type === "account" || data.type === "trustline") &&
      owns(address, data.value.accountId),
  );

  const lineOf = (asset: StellarAsset) =>
    own.find(
      ({ data }) =>
        data.type === "trustline" &&
        data.value.asset.equals(asset.toTrustLineXdrObject()),
    );

  const account = own.find(({ data }) => data.type === "account");
  const base = lineOf(usdc);

  const state = accountFromEntries(
    [account, base].flatMap((entry) => (entry ? [entry.raw] : [])),
    ledger,
    sponsor,
  );

  if (!account || account.data.type !== "account" || Option.isNone(state))
    return Option.none();

  const reserves = reservesOf(account.data.value);

  // "No operation can cause an account to have balance < (2 + numSubEntries +
  // numSponsoring - numSponsored) * baseReserve + liabilities.selling" (CAP-33).
  // https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves
  const locked =
    BigInt(2 + reserves.subentries + reserves.sponsoring - reserves.sponsored) *
      baseReserve +
    reserves.selling;

  return Option.some({
    account: state.value,
    native: amountOf(account.data.value.balance - locked),
    reserves: {
      subentries: reserves.subentries,
      sponsored: reserves.sponsored,
      sponsoring: reserves.sponsoring,
    },
    lines: assets.flatMap((asset) => {
      const line = lineOf(toStellarAsset(asset));

      if (!line || line.data.type !== "trustline") return [];

      const entry = line.data.value;

      const selling =
        entry.ext.type === "v1" ? entry.ext.v1.liabilities.selling : 0n;

      return [
        {
          asset,
          balance: amountOf(entry.balance),
          spendable: amountOf(entry.balance - selling),
          authorized:
            (entry.flags & xdr.TrustLineFlags.authorizedFlag.value) !== 0,
          sponsored: sponsoredBy(line.raw, sponsor),
        },
      ];
    }),
  });
}

export function issuerFromEntries(
  entries: ReadonlyArray<LedgerEntry>,
  issuer: AccountAddress,
): Option.Option<Issuer> {
  for (const { data } of parse(entries))
    if (data.type === "account" && owns(issuer, data.value.accountId))
      return Option.some({
        // "When AUTH_REQUIRED_FLAG is enabled, an issuer must approve an
        // account before that account can hold its asset."
        // https://developers.stellar.org/docs/tokens/control-asset-access
        authRequired:
          (data.value.flags & xdr.AccountFlags.authRequiredFlag.value) !== 0,
      });

  return Option.none();
}

export function claimablesFromEntries(
  entries: ReadonlyArray<LedgerEntry>,
  sponsor: string,
): ReadonlyArray<ClaimableEntry> {
  return parse(entries).flatMap(({ raw, data }) =>
    data.type === "claimableBalance"
      ? [
          {
            balance: Schema.decodeSync(BalanceId)(
              data.value.balanceId.toXdr("hex"),
            ),
            asset: fromStellarAsset(
              StellarAsset.fromOperation(data.value.asset),
            ),
            amount: Schema.decodeSync(PositiveAmount)(
              data.value.amount.toString(),
            ),
            claimants: data.value.claimants.map((claimant) =>
              StellarClaimant.fromXdr(claimant),
            ),
            sponsored: sponsoredBy(raw, sponsor),
          },
        ]
      : [],
  );
}

/**
 * Whether a stored predicate holds at `at` (Unix seconds). The ledger keeps
 * no relative times: creation converts them to absolute ones (CAP-23).
 */
export function claimableAt(
  predicate: xdr.ClaimPredicate,
  at: bigint,
): boolean {
  switch (predicate.type) {
    case "claimPredicateUnconditional":
      return true;
    case "claimPredicateAnd":
      return predicate.andPredicates.every((part) => claimableAt(part, at));
    case "claimPredicateOr":
      return predicate.orPredicates.some((part) => claimableAt(part, at));
    case "claimPredicateNot":
      return (
        predicate.notPredicate !== null &&
        !claimableAt(predicate.notPredicate, at)
      );
    case "claimPredicateBeforeAbsoluteTime":
      return at < predicate.absBefore;
    case "claimPredicateBeforeRelativeTime":
      return false;
  }
}

/** When a "not before" predicate, the shape Orchid gives the sender, starts to hold. */
export function opensAt(predicate: xdr.ClaimPredicate): Option.Option<bigint> {
  return predicate.type === "claimPredicateNot" &&
    predicate.notPredicate?.type === "claimPredicateBeforeAbsoluteTime"
    ? Option.some(predicate.notPredicate.absBefore)
    : Option.none();
}
