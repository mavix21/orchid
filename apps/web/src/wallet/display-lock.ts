import { useEffect, useSyncExternalStore } from "react";
import { DisplayState, makeDisplayLock } from "@workspace/wallet";
import * as Predicate from "effect/Predicate";

export const displayLock = makeDisplayLock(() => Date.now());

export const whenUnlocked = () =>
  new Promise<void>((resolve) => {
    const settle = () => {
      if (!Predicate.isTagged(displayLock.state(), "Unlocked")) return false;

      resolve();

      return true;
    };

    if (settle()) return;

    const unsubscribe = displayLock.subscribe(() => {
      if (settle()) unsubscribe();
    });
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
      else displayLock.show();
    };

    const onPageHide = () => displayLock.hide();

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
