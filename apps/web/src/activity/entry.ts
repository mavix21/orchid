import {
  type ActivityEntry,
  type Amount,
  type Asset,
  ExternalRecipient,
  LinkRecipient,
  type PaymentMemo,
  Profile,
  type Receipt,
  type ResolvedRecipient,
  type SentActivity,
} from "@workspace/wallet";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import { formattingLocale } from "@/locale/format";
import { amountLabel, assetCode, shortAddress } from "@/send/money";

export type Party = Profile | ExternalRecipient;

export type EntryBadge = {
  readonly label: string;
  readonly variant: "warning" | "neutral" | "destructive";
};

export type Direction = "in" | "out" | "unchanged";

export type Counterparty = {
  readonly label: "Para" | "De";
  readonly party: Party;
};

export type EntryMedia = "link" | Party;

export type ShownEntry = {
  readonly title: string;
  readonly subtitle: string;
  readonly badge: Option.Option<EntryBadge>;
  readonly direction: Direction;
  readonly amount: string;
  readonly detail: string;
  readonly media: EntryMedia;
  readonly counterparty: Option.Option<Counterparty>;
  readonly memo: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly openLink: boolean;
};

const sending: EntryBadge = { label: "Enviando", variant: "warning" };

const awaitingAcceptance: EntryBadge = {
  label: "Por aceptar",
  variant: "warning",
};

const unclaimed: EntryBadge = { label: "Sin cobrar", variant: "neutral" };

const notSent: EntryBadge = { label: "No se envió", variant: "destructive" };

export const partyName = (party: Party) =>
  party instanceof Profile ? `@${party.username}` : shortAddress(party.address);

export const closedOn = (closedAt: DateTime.Utc) => {
  const closed = DateTime.toDate(closedAt);

  return closed.toLocaleDateString(formattingLocale(), {
    day: "numeric",
    month: "long",
    year:
      closed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
};

const signedAmount = (direction: Direction, amount: Amount, asset: Asset) =>
  Match.value(direction).pipe(
    Match.when("in", () => `+${amountLabel(amount, asset)}`),
    Match.when("out", () => `−${amountLabel(amount, asset)}`),
    Match.when("unchanged", () => amountLabel(amount, asset)),
    Match.exhaustive,
  );

const memoText = (memo: PaymentMemo | undefined) =>
  Option.map(Option.fromUndefinedOr(memo), ({ value }) => value);

type Outcome = {
  readonly title: string;
  readonly subtitle: string;
  readonly badge: Option.Option<EntryBadge>;
  readonly direction: Direction;
  readonly detail: string;
  readonly media: EntryMedia;
  readonly counterparty: Option.Option<Counterparty>;
  readonly openLink: boolean;
};

const linkOutcome = (
  outcome: Pick<Outcome, "subtitle" | "badge" | "direction" | "detail"> & {
    readonly claimer?: Party;
    readonly open?: boolean;
  },
): Outcome => ({
  title: "Link de pago",
  subtitle: outcome.subtitle,
  badge: outcome.badge,
  direction: outcome.direction,
  detail: outcome.detail,
  media: "link",
  counterparty: Option.map(
    Option.fromUndefinedOr(outcome.claimer),
    (party) => ({
      label: "Para",
      party,
    }),
  ),
  openLink: outcome.open ?? false,
});

const claimedLinkOutcome = (
  claimer: Party | undefined,
  closedAt: DateTime.Utc,
) =>
  claimer === undefined
    ? linkOutcome({
        subtitle: "Alguien lo cobró",
        badge: Option.none(),
        direction: "out",
        detail: `Alguien cobró este link el ${closedOn(closedAt)}.`,
      })
    : claimer instanceof Profile
      ? linkOutcome({
          subtitle: `Lo cobró ${partyName(claimer)}`,
          badge: Option.none(),
          direction: "out",
          detail: `Lo cobró ${partyName(claimer)} el ${closedOn(closedAt)}.`,
          claimer,
        })
      : linkOutcome({
          subtitle: `Lo cobraron en ${partyName(claimer)}`,
          badge: Option.none(),
          direction: "out",
          detail: `Lo cobraron en ${partyName(claimer)} el ${closedOn(closedAt)}.`,
          claimer,
        });

const openLinkOutcome = linkOutcome({
  subtitle: "Nadie lo ha cobrado",
  badge: Option.some(unclaimed),
  direction: "out",
  detail: "Puedes compartirlo o recuperar el dinero.",
  open: true,
});

const linkReceiptOutcome = (receipt: Receipt) =>
  Match.valueTags(receipt, {
    Pending: () =>
      linkOutcome({
        subtitle: "Creando el link",
        badge: Option.some(sending),
        direction: "out",
        detail: "Creando tu link. Se confirma en segundos.",
      }),
    Failed: () =>
      linkOutcome({
        subtitle: "No se creó",
        badge: Option.some(notSent),
        direction: "unchanged",
        detail: "No se creó el link. Tu dinero no se movió.",
      }),
    Settled: () => openLinkOutcome,
    Reserved: () => openLinkOutcome,
    Claimed: ({ by, closedAt }) => claimedLinkOutcome(by, closedAt),
    Refunded: ({ closedAt }) =>
      linkOutcome({
        subtitle: "Recuperaste el dinero",
        badge: Option.none(),
        direction: "unchanged",
        detail: `Recuperaste el dinero de este link el ${closedOn(closedAt)}.`,
      }),
  });

const paymentOutcome = (
  party: Party,
  outcome: Pick<Outcome, "badge" | "direction" | "detail"> & {
    readonly subtitle?: string;
  },
): Outcome => ({
  title: partyName(party),
  subtitle: outcome.subtitle ?? "Enviaste",
  badge: outcome.badge,
  direction: outcome.direction,
  detail: outcome.detail,
  media: party,
  counterparty: Option.some({ label: "Para", party }),
  openLink: false,
});

const paymentReceiptOutcome = (receipt: Receipt, party: Party) => {
  const name = partyName(party);

  return Match.valueTags(receipt, {
    Pending: () =>
      paymentOutcome(party, {
        badge: Option.some(sending),
        direction: "out",
        detail: "Enviando. Se confirma en segundos.",
      }),
    Settled: () =>
      paymentOutcome(party, {
        badge: Option.none(),
        direction: "out",
        detail: `Llegó a ${name}.`,
      }),
    Reserved: () =>
      paymentOutcome(party, {
        badge: Option.some(awaitingAcceptance),
        direction: "out",
        detail: `Esperando que ${name} lo acepte.`,
      }),
    Claimed: ({ closedAt }) =>
      paymentOutcome(party, {
        badge: Option.none(),
        direction: "out",
        detail: `${name} lo aceptó el ${closedOn(closedAt)}.`,
      }),
    Refunded: ({ closedAt }) =>
      paymentOutcome(party, {
        subtitle: "Volvió a tu cuenta",
        badge: Option.none(),
        direction: "unchanged",
        detail: `El pago volvió a tu cuenta el ${closedOn(closedAt)}.`,
      }),
    Failed: ({ reason }) =>
      paymentOutcome(party, {
        badge: Option.some(notSent),
        direction: "unchanged",
        detail: Match.value(reason).pipe(
          Match.when(
            "expired",
            () => "No se envió a tiempo. Tu dinero no se movió.",
          ),
          Match.when(
            "rejected",
            () => "La red rechazó el pago. Tu dinero no se movió.",
          ),
          Match.exhaustive,
        ),
      }),
  });
};

const recipientParty = (recipient: ResolvedRecipient): Option.Option<Party> =>
  recipient instanceof LinkRecipient ? Option.none() : Option.some(recipient);

const sentEntry = ({ receipt, createdAt }: SentActivity): ShownEntry => {
  const outcome = Option.match(recipientParty(receipt.recipient), {
    onNone: () => linkReceiptOutcome(receipt),
    onSome: (party) => paymentReceiptOutcome(receipt, party),
  });

  return {
    ...outcome,
    amount: signedAmount(outcome.direction, receipt.amount, receipt.asset),
    memo: memoText(receipt.memo),
    createdAt,
  };
};

const receivedEntry = (
  entry: {
    from: Profile;
    amount: Amount;
    asset: Asset;
    createdAt: DateTime.Utc;
  },
  outcome: Pick<Outcome, "subtitle" | "badge" | "direction" | "detail">,
): ShownEntry => ({
  ...outcome,
  title: partyName(entry.from),
  media: entry.from,
  counterparty: Option.some({ label: "De", party: entry.from }),
  openLink: false,
  amount: signedAmount(outcome.direction, entry.amount, entry.asset),
  memo: Option.none(),
  createdAt: entry.createdAt,
});

export const shownEntry = (entry: ActivityEntry): ShownEntry =>
  Match.valueTags(entry, {
    SentActivity: sentEntry,
    ReceivedActivity: (received) =>
      receivedEntry(received, {
        subtitle: "Recibiste",
        badge: Option.none(),
        direction: "in",
        detail: `${partyName(received.from)} te envió este pago.`,
      }),
    AwaitingAcceptanceActivity: (awaiting) =>
      receivedEntry(awaiting, {
        subtitle: `Te envió ${assetCode(awaiting.asset)}`,
        badge: Option.some(awaitingAcceptance),
        direction: "unchanged",
        detail: "Llega a tu saldo cuando lo recibas con tu passkey.",
      }),
    TakenBackActivity: (takenBack) =>
      receivedEntry(takenBack, {
        subtitle: "Lo recuperó",
        badge: Option.none(),
        direction: "unchanged",
        detail: `${partyName(takenBack.from)} recuperó este pago el ${closedOn(takenBack.closedAt)}.`,
      }),
    ClaimedLinkActivity: (claimed) =>
      receivedEntry(claimed, {
        subtitle: "Cobraste su link",
        badge: Option.none(),
        direction: "in",
        detail: `Cobraste un link de pago de ${partyName(claimed.from)}.`,
      }),
    DepositActivity: (deposit): ShownEntry => ({
      title: "Depósito",
      subtitle: "Desde otra billetera",
      badge: Option.none(),
      direction: "in",
      detail: "Llegó desde otra billetera o exchange.",
      media: deposit.from,
      counterparty: Option.some({ label: "De", party: deposit.from }),
      amount: signedAmount("in", deposit.amount, deposit.asset),
      memo: Option.none(),
      createdAt: deposit.createdAt,
      openLink: false,
    }),
  });

export const entryKey = (entry: ActivityEntry) => `${entry._tag}:${entry.id}`;

export const createdWhen = (createdAt: DateTime.Utc) => {
  const created = DateTime.toDate(createdAt);
  const today = new Date();

  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );

  const time = created.toLocaleTimeString(formattingLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  if (created.toDateString() === today.toDateString()) return `Hoy, ${time}`;

  if (created.toDateString() === yesterday.toDateString())
    return `Ayer, ${time}`;

  return created.toLocaleDateString(formattingLocale(), {
    day: "numeric",
    month: "short",
    year: created.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
};

export const createdAtLabel = (createdAt: DateTime.Utc) =>
  DateTime.toDate(createdAt).toLocaleString(formattingLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
