import { Account } from "@stellar/stellar-sdk";
import * as DateTime from "effect/DateTime";
import {
  type AccountAddress,
  type BalanceId,
  OpeningDraft,
  SigningRequest,
  type UnsignedEnvelope,
} from "../contract";
import { draftOpening, draftRecovery, pinnedSequence } from "./envelopes";
import { paymentLifetime, recoveryDelay, recoveryWindow } from "./network";

export interface OpeningSchedule {
  readonly lifetime: number;
  readonly ledgers: number;
  readonly recoveryDelay: number;
  readonly recoveryWindow: number;
}

export const standardSchedule: OpeningSchedule = {
  lifetime: paymentLifetime,
  ledgers: paymentLifetime,
  recoveryDelay,
  recoveryWindow,
};

export interface OpeningDraftInput {
  readonly source: Account;
  readonly address: AccountAddress;
  readonly reserveSponsor: AccountAddress;
  readonly observedSequence: string | undefined;
  readonly now: number;
  readonly latestLedger: number;
  readonly pinSequence: boolean;
  readonly claim?: BalanceId;
  readonly schedule?: OpeningSchedule;
}

const requestOf = (envelope: UnsignedEnvelope, maxTime: number) =>
  new SigningRequest({
    envelope,
    expiresAt: DateTime.makeUnsafe(maxTime * 1000),
  });

export function draftOpeningWithRecovery(
  input: OpeningDraftInput,
): OpeningDraft {
  const schedule = input.schedule ?? standardSchedule;
  const maxTime = input.now + schedule.lifetime;

  const window = {
    minLedger: input.latestLedger,
    maxLedger: input.latestLedger + schedule.ledgers + 1,
  };

  const pinned =
    input.pinSequence &&
    (input.observedSequence === undefined ||
      BigInt(input.observedSequence) < pinnedSequence(window));

  const opening = requestOf(
    draftOpening({
      source: input.source,
      address: input.address,
      minTime: input.now,
      maxTime,
      createAccount: input.observedSequence === undefined,
      window: pinned ? window : undefined,
      claim: input.claim,
    }),
    maxTime,
  );

  if (!pinned) return new OpeningDraft({ request: opening });

  const recoveryMinTime = maxTime + schedule.recoveryDelay;
  const recoveryMaxTime = recoveryMinTime + schedule.recoveryWindow;

  return new OpeningDraft({
    request: opening,
    recovery: requestOf(
      draftRecovery({
        source: new Account(input.address, pinnedSequence(window).toString()),
        reserveSponsor: input.reserveSponsor,
        minTime: recoveryMinTime,
        maxTime: recoveryMaxTime,
        minLedger: window.maxLedger,
      }),
      recoveryMaxTime,
    ),
  });
}
