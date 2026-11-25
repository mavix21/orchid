import { Address, xdr } from "@stellar/stellar-sdk";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type AccountAddress, BalanceId } from "../contract";
import { depositContract } from "../stellar/network";
import type { ChainUnreachable } from "./chain-errors.server";
import type { StellarRpc } from "./ledger.server";

export interface LedgerWindow {
  readonly oldestLedger: number;
  readonly latestLedger: number;
}

export type AssetEvent = Data.TaggedEnum<{
  Payment: {
    readonly eventId: string;
    readonly from: string;
    readonly to: string;
    readonly amount: bigint;
    readonly hash: string;
    readonly ledger: number;
    readonly closedAt: DateTime.Utc;
  };
  BalanceClaim: {
    readonly eventId: string;
    readonly balance: BalanceId;
    readonly closedAt: DateTime.Utc;
  };
}>;

export const AssetEvent = Data.taggedEnum<AssetEvent>();

export type EventsStart = Data.TaggedEnum<{
  FromLedger: { readonly ledger: number };
  FromCursor: { readonly cursor: string };
}>;

export const EventsStart = Data.taggedEnum<EventsStart>();

export interface EventsQuery {
  readonly start: EventsStart;
  readonly wallet: Option.Option<AccountAddress>;
  readonly limit: number;
}

export interface EventsPage {
  readonly events: ReadonlyArray<AssetEvent>;
  readonly cursor: string;
  readonly cursorLedger: number;
  readonly drained: boolean;
  readonly cursorClosedAt: Option.Option<DateTime.Utc>;
}

export interface DepositChain {
  readonly ledgerWindow: Effect.Effect<LedgerWindow, ChainUnreachable>;
  assetEvents(query: EventsQuery): Effect.Effect<EventsPage, ChainUnreachable>;
}

const EventCursor = Schema.String.check(Schema.isPattern(/^\d{19}-\d{10}$/u));

const RawAssetEvent = Schema.Struct({
  id: EventCursor,
  ledger: Schema.Number,
  ledgerClosedAt: Schema.DateTimeUtcFromString,
  txHash: Schema.String,
  topic: Schema.Array(Schema.String),
  value: Schema.String,
});

type RawAssetEvent = typeof RawAssetEvent.Type;

const RawAssetEvents = Schema.Struct({
  events: Schema.Array(RawAssetEvent),
  cursor: EventCursor,
  latestLedger: Schema.Number,
  latestLedgerCloseTime: Schema.NumberFromString,
});

const RawHealth = Schema.Struct({
  latestLedger: Schema.Number,
  oldestLedger: Schema.Number,
});

const ledgerOfCursor = (cursor: string) =>
  Number(BigInt(cursor.slice(0, 19)) >> 32n);

const symbolTopic = (name: string) => xdr.ScVal.scvSymbol(name).toXDR("base64");

const topicsFor = (wallet: Option.Option<AccountAddress>) => {
  const to = Option.match(wallet, {
    onNone: () => "*",
    onSome: (address) => new Address(address).toScVal().toXDR("base64"),
  });

  return [
    [symbolTopic("transfer"), "*", to, "*"],
    [symbolTopic("mint"), to, "*"],
  ];
};

const textOf = (value: xdr.ScVal) =>
  Match.value(value).pipe(
    Match.when({ type: "scvSymbol" }, ({ sym }) => Option.some(sym.toString())),
    Match.when({ type: "scvString" }, ({ str }) => Option.some(str.toString())),
    Match.orElse(() => Option.none<string>()),
  );

const addressOf = (value: xdr.ScVal) =>
  value.type === "scvAddress"
    ? Option.some(Address.fromScAddress(value.address))
    : Option.none();

const amountOf = (value: xdr.ScVal): Option.Option<bigint> => {
  if (value.type === "scvI128")
    return Option.some(value.i128.hi * 2n ** 64n + value.i128.lo);

  if (value.type !== "scvMap") return Option.none();

  const entry = (value.map ?? []).find((candidate) =>
    Option.contains(textOf(candidate.key), "amount"),
  );

  return entry === undefined ? Option.none() : amountOf(entry.val);
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const balanceOf = (address: Address) =>
  Schema.decodeOption(BalanceId)(`000000${hex(address.toBuffer())}`);

const assetEventOf = (raw: RawAssetEvent): Option.Option<AssetEvent> => {
  const topics = raw.topic.map((topic) => xdr.ScVal.fromXDR(topic, "base64"));
  const [kind, ...rest] = topics;

  const sender = Option.gen(function* () {
    const name = yield* Option.flatMap(Option.fromUndefinedOr(kind), textOf);

    if (name === "transfer" && rest.length === 3)
      return {
        from: yield* Option.flatMap(Option.fromUndefinedOr(rest[0]), addressOf),
        to: yield* Option.flatMap(Option.fromUndefinedOr(rest[1]), addressOf),
      };

    if (name === "mint" && rest.length === 2) {
      const asset = yield* Option.flatMap(
        Option.fromUndefinedOr(rest[1]),
        textOf,
      );

      const issuer = asset.split(":")[1];

      return {
        from: yield* Option.map(
          Option.fromUndefinedOr(issuer),
          (value) => new Address(value),
        ),
        to: yield* Option.flatMap(Option.fromUndefinedOr(rest[0]), addressOf),
      };
    }

    return yield* Option.none();
  });

  return Option.flatMap(sender, ({ from, to }): Option.Option<AssetEvent> =>
    from.type === "claimableBalance"
      ? Option.map(balanceOf(from), (balance): AssetEvent =>
          AssetEvent.BalanceClaim({
            eventId: raw.id,
            balance,
            closedAt: raw.ledgerClosedAt,
          }),
        )
      : Option.map(
          amountOf(xdr.ScVal.fromXDR(raw.value, "base64")),
          (amount): AssetEvent =>
            AssetEvent.Payment({
              eventId: raw.id,
              from: from.toString(),
              to: to.toString(),
              amount,
              hash: raw.txHash,
              ledger: raw.ledger,
              closedAt: raw.ledgerClosedAt,
            }),
        ),
  );
};

const readable = (
  raw: RawAssetEvent,
): Effect.Effect<Option.Option<AssetEvent>> =>
  Effect.try({
    try: () => assetEventOf(raw),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Asset event could not be read", raw.id, cause).pipe(
        Effect.as(Option.none<AssetEvent>()),
      ),
    ),
  );

export const depositChain = (rpc: StellarRpc): DepositChain => ({
  ledgerWindow: rpc.call("getHealth", {}, RawHealth),
  assetEvents: Effect.fn("Chain.assetEvents")(function* (query: EventsQuery) {
    const filters = [
      {
        type: "contract",
        contractIds: [depositContract],
        topics: topicsFor(query.wallet),
      },
    ];

    const reply = yield* rpc.call(
      "getEvents",
      Match.valueTags(query.start, {
        FromLedger: ({ ledger }) => ({
          filters,
          startLedger: ledger,
          pagination: { limit: query.limit },
        }),
        FromCursor: ({ cursor }) => ({
          filters,
          pagination: { limit: query.limit, cursor },
        }),
      }),
      RawAssetEvents,
    );

    const cursorLedger = ledgerOfCursor(reply.cursor);
    const last = reply.events.at(-1);
    const truncated = last !== undefined && last.id === reply.cursor;
    const drained = !truncated && cursorLedger >= reply.latestLedger;

    const events = yield* Effect.forEach(reply.events, readable);

    return {
      events: events.flatMap((event) =>
        Option.isSome(event) ? [event.value] : [],
      ),
      cursor: reply.cursor,
      cursorLedger,
      drained,
      cursorClosedAt: truncated
        ? Option.some(last.ledgerClosedAt)
        : drained
          ? Option.some(DateTime.makeUnsafe(reply.latestLedgerCloseTime * 1000))
          : Option.none(),
    };
  }),
});
