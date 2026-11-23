import { expect, it } from "@effect/vitest";
import {
  type DisplayLock,
  type HiddenSinceStore,
  makeDisplayLock,
} from "../src/device/display-lock";

const resumeWindow = 60_000;

interface Tab {
  readonly clock: { now: number };
  readonly lock: DisplayLock;
}

const sessionStore = (): HiddenSinceStore => {
  let stored: number | undefined;

  return {
    read: () => stored,
    write: (hiddenSince) => {
      stored = hiddenSince;
    },
    clear: () => {
      stored = undefined;
    },
  };
};

const tabAt = (
  store: HiddenSinceStore = sessionStore(),
  clock = { now: 1_000_000 },
): Tab => ({ clock, lock: makeDisplayLock(() => clock.now, store) });

const unlockedTab = () => {
  const tab = tabAt();

  tab.lock.unlock(tab.lock.begin());

  return tab;
};

const awayFor = (milliseconds: number) => {
  const { clock, lock } = unlockedTab();

  lock.hide();
  clock.now += milliseconds;
  lock.show();

  return lock.state()._tag;
};

it.each([
  ["just under the resume window", resumeWindow - 1, "Unlocked"],
  ["exactly the resume window", resumeWindow, "Locked"],
  ["a clock set backwards", -1, "Locked"],
] as const)(
  "after being away for %s the display is %s",
  (_, away, expected) => {
    expect(awayFor(away)).toBe(expected);
  },
);

it("masks on hide and never counts a later hide as the start of the absence", () => {
  const { clock, lock } = unlockedTab();

  lock.hide();

  expect(lock.state()._tag).toBe("Masked");

  clock.now += resumeWindow - 1;
  lock.hide();
  clock.now += resumeWindow - 1;
  lock.show();

  expect(lock.state()._tag).toBe("Locked");
});

it("refuses a secret-bearing verification that completes after the page was hidden", () => {
  const { lock } = tabAt();
  const ticket = lock.begin();

  lock.hide();
  lock.show();
  lock.unlock(ticket);

  expect(lock.state()._tag).toBe("Locked");
});

it("an entry that verifies while the page is hidden unlocks once the page is back within the window", () => {
  const tab = tabAt();
  const attempt = tab.lock.attemptEntry();

  tab.lock.hide();
  tab.clock.now += 1_000;
  tab.lock.entryVerified(attempt);
  tab.clock.now += 29_000;
  tab.lock.show();

  expect(tab.lock.state()._tag).toBe("Unlocked");
});

it.each([
  [
    "completes while still hidden past the window",
    (tab: Tab, verify: () => void) => {
      tab.clock.now += resumeWindow;
      verify();
      tab.lock.show();
    },
  ],
  [
    "completes while hidden but the page returns after the window",
    (tab: Tab, verify: () => void) => {
      tab.clock.now += 1_000;
      verify();
      tab.clock.now += resumeWindow - 1_000;
      tab.lock.show();
    },
  ],
] as const)("an entry that %s never unlocks", (_, afterHide) => {
  const tab = tabAt();
  const attempt = tab.lock.attemptEntry();

  tab.lock.hide();
  afterHide(tab, () => tab.lock.entryVerified(attempt));

  expect(tab.lock.state()._tag).toBe("Locked");
});

it.each([
  [
    "a restored page",
    (lock: DisplayLock) => {
      lock.hide();
      lock.relock();
    },
  ],
  [
    "a cancellation",
    (lock: DisplayLock, attempt: ReturnType<DisplayLock["attemptEntry"]>) => {
      lock.cancelEntry(attempt);
    },
  ],
  [
    "a replacement",
    (lock: DisplayLock) => {
      lock.attemptEntry();
    },
  ],
] as const)("an entry voided by %s never unlocks", (_, voidAttempt) => {
  const { lock } = tabAt();
  const attempt = lock.attemptEntry();

  voidAttempt(lock, attempt);
  lock.entryVerified(attempt);

  expect(lock.state()._tag).toBe("Locked");
});

const reloadedAfter = (
  milliseconds: number,
  leaveTab: (lock: DisplayLock) => void,
) => {
  const store = sessionStore();
  const { clock, lock } = tabAt(store);

  lock.unlock(lock.begin());
  leaveTab(lock);
  clock.now += milliseconds;

  const reloaded = tabAt(store, clock).lock;

  reloaded.show();

  return reloaded.state()._tag;
};

it.each([
  {
    away: "just under the resume window",
    millis: resumeWindow - 1,
    expected: "Unlocked",
  },
  {
    away: "exactly the resume window",
    millis: resumeWindow,
    expected: "Locked",
  },
  { away: "a clock set backwards", millis: -1, expected: "Locked" },
] as const)(
  "a tab reloaded after being hidden for $away ends up $expected",
  ({ millis, expected }) => {
    expect(reloadedAfter(millis, (lock) => lock.hide())).toBe(expected);
  },
);

it.each([
  ["it was hidden before unlocking", (lock: DisplayLock) => lock.hide()],
  [
    "the page was restored from cache",
    (lock: DisplayLock) => {
      lock.unlock(lock.begin());
      lock.hide();
      lock.relock();
    },
  ],
] as const)("a tab reloaded after %s stays locked", (_, leaveTab) => {
  const store = sessionStore();
  const { clock, lock } = tabAt(store);

  leaveTab(lock);

  expect(tabAt(store, clock).lock.state()._tag).toBe("Locked");
});

it("a reloaded tab that stays hidden resumes only if it returns within the window of the original hide", () => {
  const store = sessionStore();
  const { clock, lock } = tabAt(store);

  lock.unlock(lock.begin());
  lock.hide();
  clock.now += 30_000;

  const reloaded = tabAt(store, clock).lock;

  expect(reloaded.state()._tag).toBe("Masked");

  reloaded.hide();
  clock.now += 29_999;
  reloaded.show();

  expect(reloaded.state()._tag).toBe("Unlocked");
});

it("a tab that came back does not resume again on a later reload", () => {
  const store = sessionStore();
  const { clock, lock } = tabAt(store);

  lock.unlock(lock.begin());
  lock.hide();
  lock.show();

  expect(tabAt(store, clock).lock.state()._tag).toBe("Locked");
});
