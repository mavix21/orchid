import { useCallback, useEffect, useRef, useState } from "react";
import type { PasskeyChallenge, WalletClient } from "@workspace/wallet";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

const freshForMillis = 4 * 60_000;

const staleCheckEveryMillis = 30_000;

export type HeldChallenge = Data.TaggedEnum<{
  Fetching: {};
  Ready: { readonly challenge: PasskeyChallenge; readonly issuedAt: number };
  Unreachable: {};
}>;

export const HeldChallenge = Data.taggedEnum<HeldChallenge>();

const staleAt = (held: HeldChallenge, now: number) =>
  Predicate.isTagged(held, "Unreachable") ||
  (Predicate.isTagged(held, "Ready") && now - held.issuedAt >= freshForMillis);

export function useSessionChallenge(
  client: Pick<WalletClient, "sessionChallenge">,
) {
  const [held, setHeld] = useState<HeldChallenge>(HeldChallenge.Fetching());
  const latest = useRef(held);
  const fetching = useRef(false);

  const hold = useCallback((next: HeldChallenge) => {
    latest.current = next;
    setHeld(next);
  }, []);

  const refresh = useCallback(async () => {
    if (fetching.current) return;

    fetching.current = true;
    hold(HeldChallenge.Fetching());

    const outcome = await client.sessionChallenge();

    fetching.current = false;
    hold(
      Predicate.isTagged(outcome, "ChallengeIssued")
        ? HeldChallenge.Ready({
            challenge: outcome.challenge,
            issuedAt: Date.now(),
          })
        : HeldChallenge.Unreachable(),
    );
  }, [client, hold]);

  useEffect(() => {
    void refresh();

    const refreshWhenStale = () => {
      if (
        document.visibilityState === "visible" &&
        staleAt(latest.current, Date.now())
      )
        void refresh();
    };

    const timer = window.setInterval(refreshWhenStale, staleCheckEveryMillis);

    document.addEventListener("visibilitychange", refreshWhenStale);
    window.addEventListener("pageshow", refreshWhenStale);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenStale);
      window.removeEventListener("pageshow", refreshWhenStale);
    };
  }, [refresh]);

  return { held, refresh };
}
