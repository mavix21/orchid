import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

export const resumeWindowMillis = 60_000;

export type DisplayState = Data.TaggedEnum<{
  Locked: {};
  Unlocked: {};
  Masked: { readonly hiddenAt: number };
}>;

export const DisplayState = Data.taggedEnum<DisplayState>();

export class VerificationTicket extends Data.TaggedClass("VerificationTicket")<{
  readonly epoch: number;
}> {}

export interface DisplayLock {
  state(): DisplayState;
  subscribe(listener: () => void): () => void;
  begin(): VerificationTicket;
  unlock(ticket: VerificationTicket): void;
  hide(): void;
  show(): void;
  relock(): void;
}

export function makeDisplayLock(now: () => number): DisplayLock {
  let current: DisplayState = DisplayState.Locked();
  let epoch = 0;
  const listeners = new Set<() => void>();

  const transition = (next: DisplayState) => {
    if (next._tag === current._tag) return;

    current = next;

    for (const listener of listeners) listener();
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
    hide: () => {
      epoch += 1;

      if (Predicate.isTagged(current, "Unlocked"))
        transition(DisplayState.Masked({ hiddenAt: now() }));
    },
    show: () => {
      if (!Predicate.isTagged(current, "Masked")) return;

      const away = now() - current.hiddenAt;

      transition(
        away >= 0 && away < resumeWindowMillis
          ? DisplayState.Unlocked()
          : DisplayState.Locked(),
      );
    },
    relock: () => {
      epoch += 1;
      transition(DisplayState.Locked());
    },
  };
}
