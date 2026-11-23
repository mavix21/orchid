import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { OpeningDraft, SigningRequest } from "../contract";
import { readEnvelope } from "../stellar/envelopes";
import { Sealed } from "./Chain.server";
import type { wallets } from "./tables.server";

type WalletRow = typeof wallets.$inferSelect;

const pairedRecoveryRequest = (
  row: WalletRow,
): Option.Option<SigningRequest> => {
  if (!row.pairedRecoveryDraft) return Option.none();

  const envelope = Schema.decodeSync(SigningRequest.fields.envelope)(
    row.pairedRecoveryDraft,
  );

  return readEnvelope(envelope).pipe(
    Option.filter((facts) => Predicate.isTagged(facts, "RecoveryFacts")),
    Option.map(
      (facts) =>
        new SigningRequest({
          envelope,
          expiresAt: DateTime.makeUnsafe(facts.maxTime * 1000),
        }),
    ),
  );
};

export function pairedRecovery(row: WalletRow): Option.Option<{
  readonly request: SigningRequest;
  readonly sealed: Sealed;
}> {
  if (!row.pairedRecoveryEnvelope || !row.pairedRecoveryHash)
    return Option.none();

  const sealedEnvelope = row.pairedRecoveryEnvelope;
  const sealedHash = row.pairedRecoveryHash;

  return pairedRecoveryRequest(row).pipe(
    Option.map((request) => ({
      request,
      sealed: new Sealed({
        envelope: sealedEnvelope,
        hash: sealedHash,
        expiresAt: request.expiresAt,
      }),
    })),
  );
}

export function openingAttempt(
  row: WalletRow,
): Option.Option<OpeningDraft | Sealed> {
  if (!row.attemptEnvelope || !row.attemptExpiresAt) return Option.none();

  const expiresAt = DateTime.makeUnsafe(row.attemptExpiresAt);

  if (row.attemptHash)
    return Option.some(
      new Sealed({
        envelope: row.attemptEnvelope,
        hash: row.attemptHash,
        expiresAt,
      }),
    );

  const recovery = pairedRecoveryRequest(row);

  return Option.some(
    new OpeningDraft({
      request: new SigningRequest({
        envelope: Schema.decodeSync(SigningRequest.fields.envelope)(
          row.attemptEnvelope,
        ),
        expiresAt,
      }),
      recovery: Option.getOrUndefined(recovery),
    }),
  );
}
