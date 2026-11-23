import { useEffect, useSyncExternalStore } from "react";
import {
  DisplayState,
  type HiddenSinceStore,
  makeDisplayLock,
} from "@workspace/wallet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const hiddenSinceKey = "orchid-display-hidden-since";

const decodeHiddenSince = Schema.decodeOption(Schema.FiniteFromString);

const sessionHiddenSince: HiddenSinceStore = {
  read: () => {
    try {
      return Option.fromNullishOr(sessionStorage.getItem(hiddenSinceKey)).pipe(
        Option.flatMap(decodeHiddenSince),
        Option.getOrUndefined,
      );
    } catch {
      return undefined;
    }
  },
  write: (hiddenSince) => {
    try {
      sessionStorage.setItem(hiddenSinceKey, String(hiddenSince));
    } catch {
      return;
    }
  },
  clear: () => {
    try {
      sessionStorage.removeItem(hiddenSinceKey);
    } catch {
      return;
    }
  },
};

export const displayLock = makeDisplayLock(
  () => Date.now(),
  sessionHiddenSince,
);

export const whenUnlocked = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    if (Predicate.isTagged(displayLock.state(), "Unlocked")) {
      resolve();

      return;
    }

    const stop = () => {
      unsubscribe();
      signal.removeEventListener("abort", abandon);
    };

    const abandon = () => {
      stop();
      reject(signal.reason);
    };

    const unsubscribe = displayLock.subscribe(() => {
      if (!Predicate.isTagged(displayLock.state(), "Unlocked")) return;

      stop();
      resolve();
    });

    signal.addEventListener("abort", abandon);
  });

const lockedOnServer = DisplayState.Locked();

export const useDisplayState = () =>
  useSyncExternalStore(
    displayLock.subscribe,
    displayLock.state,
    () => lockedOnServer,
  );

export function useDisplayLockLifecycle() {
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") displayLock.hide();
      else displayLock.show();
    };

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) displayLock.relock();
      else if (document.visibilityState === "visible") displayLock.show();
    };

    const onPageHide = () => displayLock.hide();

    if (document.visibilityState === "visible") displayLock.show();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);
}
