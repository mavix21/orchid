import {
  type ActivityEntry,
  type Amount,
  ExternalRecipient,
  Profile,
} from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

export const lookalikeDistance = 2;

export const largeShareDivisor = 2n;

export const RiskFlag = Schema.Literals([
  "first_payment",
  "lookalike_username",
  "external_address",
  "memo_required",
  "muxed_address",
  "large_share",
]);

export type RiskFlag = typeof RiskFlag.Type;

export const editDistance = (left: string, right: string) => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (const [row, leftCharacter] of [...left].entries()) {
    const current = [row + 1];

    for (const [column, rightCharacter] of [...right].entries())
      current.push(
        Math.min(
          (previous[column + 1] ?? 0) + 1,
          (current[column] ?? 0) + 1,
          (previous[column] ?? 0) + (leftCharacter === rightCharacter ? 0 : 1),
        ),
      );

    previous = current;
  }

  return previous[right.length] ?? 0;
};

export class PaidCounterparts extends Schema.Class<PaidCounterparts>(
  "PaidCounterparts",
)({
  usernames: Schema.Array(Schema.String),
  addresses: Schema.Array(Schema.String),
}) {}

export const paidCounterpartsOf = (entries: ReadonlyArray<ActivityEntry>) => {
  const recipients = entries.flatMap((entry) =>
    Match.value(entry).pipe(
      Match.tag("SentActivity", ({ receipt }) => [receipt.recipient]),
      Match.orElse(() => []),
    ),
  );

  return new PaidCounterparts({
    usernames: recipients.flatMap((recipient) =>
      recipient instanceof Profile ? [recipient.username] : [],
    ),
    addresses: recipients.flatMap((recipient) =>
      recipient instanceof ExternalRecipient ? [recipient.address] : [],
    ),
  });
};

const flag = (raised: boolean, risk: RiskFlag): ReadonlyArray<RiskFlag> =>
  raised ? [risk] : [];

export const recipientRisks = (
  recipient: Profile | ExternalRecipient,
  paid: PaidCounterparts,
): ReadonlyArray<RiskFlag> => {
  if (recipient instanceof Profile) {
    const known = paid.usernames.includes(recipient.username);

    const lookalike = paid.usernames.some(
      (username) =>
        editDistance(username, recipient.username) <= lookalikeDistance,
    );

    return [
      ...flag(!known, "first_payment"),
      ...flag(!known && lookalike, "lookalike_username"),
    ];
  }

  return [
    ...flag(!paid.addresses.includes(recipient.address), "first_payment"),
    ...flag(true, "external_address"),
    ...flag(recipient.address.startsWith("M"), "muxed_address"),
  ];
};

export const amountRisks = (
  amount: Amount,
  balance: Amount,
): ReadonlyArray<RiskFlag> =>
  flag(amount * largeShareDivisor > balance, "large_share");

export const memoRisks = (required: boolean) => flag(required, "memo_required");
