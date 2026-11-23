import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

export const resumeWindowMillis = 60_000;

export type DisplayState = Data.TaggedEnum<{
  Locked: {};
  Unlocked: {};
  Masked: {};
}>;

export const DisplayState = Data.taggedEnum<DisplayState>();

export class VerificationTicket extends Data.TaggedClass("VerificationTicket")<{
  readonly epoch: number;
}> {}

export class EntryAttempt extends Data.TaggedClass("EntryAttempt")<{
  readonly id: number;
}> {}

export interface DisplayLock {
  state(): DisplayState;
  subscribe(listener: () => void): () => void;
  begin(): VerificationTicket;
  unlock(ticket: VerificationTicket): void;
  attemptEntry(): EntryAttempt;
  entryPending(attempt: EntryAttempt): boolean;
  entryVerified(attempt: EntryAttempt): void;
  cancelEntry(attempt: EntryAttempt): void;
  hide(): void;
  show(): void;
  relock(): void;
}

interface PendingEntry {
  readonly id: number;
  readonly verified: boolean;
}

export function makeDisplayLock(now: () => number): DisplayLock {
  let current: DisplayState = DisplayState.Locked();
  let epoch = 0;
  let attempts = 0;
  let pending: PendingEntry | undefined;
  let hiddenSince: number | undefined;
  const listeners = new Set<() => void>();

  const transition = (next: DisplayState) => {
    if (next._tag === current._tag) return;

    current = next;

    for (const listener of listeners) listener();
  };

  const awayWithinWindow = (since: number) => {
    const away = now() - since;

    return away >= 0 && away < resumeWindowMillis;
  };

  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    begin: () => new VerificationTicket({ epoch }),
    unlock: (ticket) => {
      if (ticket.epoch === epoch) transition(DisplayState.Unlocked());
    },
    attemptEntry: () => {
      attempts += 1;
      pending = { id: attempts, verified: false };

      return new EntryAttempt({ id: attempts });
    },
    entryPending: (attempt) => pending?.id === attempt.id,
    entryVerified: (attempt) => {
      if (pending?.id !== attempt.id) return;

      if (hiddenSince === undefined) {
        pending = undefined;
        transition(DisplayState.Unlocked());

        return;
      }

      pending = awayWithinWindow(hiddenSince)
        ? { id: attempt.id, verified: true }
        : undefined;
    },
    cancelEntry: (attempt) => {
      if (pending?.id === attempt.id) pending = undefined;
    },
    hide: () => {
      epoch += 1;
      hiddenSince ??= now();

      if (Predicate.isTagged(current, "Unlocked"))
        transition(DisplayState.Masked());
    },
    show: () => {
      if (hiddenSince === undefined) return;

      const resumed = awayWithinWindow(hiddenSince);

      hiddenSince = undefined;

      if (!resumed) pending = undefined;

      const verified = resumed && pending?.verified === true;

      if (verified) pending = undefined;

      if (verified || (resumed && Predicate.isTagged(current, "Masked")))
        transition(DisplayState.Unlocked());
      else if (Predicate.isTagged(current, "Masked"))
        transition(DisplayState.Locked());
    },
    relock: () => {
      epoch += 1;
      pending = undefined;
      hiddenSince = undefined;
      transition(DisplayState.Locked());
    },
  };
}
