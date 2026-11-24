import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type AccountAddress, Amount } from "../src/contract";
import type {
  AccountState,
  Sealed,
  Settlement,
} from "../src/server/Chain.server";
import type { KnownExchangeMemo } from "../src/server/exchange-memos.server";
import type {
  ClaimableEntry,
  Holdings,
} from "../src/server/ledger-assets.server";

export const world = {
  humanCheckRefused: false,
  humanChecks: 0,
  accounts: new Map<AccountAddress, AccountState>(),
  evidence: new Map<string, Settlement>(),
  submitted: new Array<Sealed>(),
  exchangeMemos: new Array<KnownExchangeMemo>(),
  failSubmit: false,
  ledgerDown: false,
  unreadable: new Set<string>(),
  claimablesDown: false,
  holdings: new Map<AccountAddress, Holdings>(),
  claimables: new Map<string, ClaimableEntry>(),
  issuers: new Map<AccountAddress, { readonly authRequired: boolean }>(),
};

export const amount = (value: string) => Schema.decodeSync(Amount)(value);

export const accountState = (
  overrides: Partial<AccountState> = {},
): AccountState => ({
  sequence: "1000",
  ledger: 100,
  accountSponsored: true,
  sponsored: true,
  untouched: true,
  nativeBalance: 0n,
  balance: Option.some(amount("50000000")),
  ...overrides,
});

export const holdingsFor = (
  address: AccountAddress,
  overrides: Partial<Holdings> = {},
): Holdings => ({
  account: world.accounts.get(address) ?? accountState(),
  reserveSponsor: Option.none(),
  native: amount("0"),
  reserves: { subentries: 2, sponsored: 4, sponsoring: 0 },
  lines: [],
  ...overrides,
});
