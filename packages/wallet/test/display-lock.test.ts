import { expect, it } from "@effect/vitest";
import { type DisplayLock, makeDisplayLock } from "../src/device/display-lock";

const resumeWindow = 60_000;

interface Tab {
  readonly clock: { now: number };
  readonly lock: DisplayLock;
}

const tabAt = (): Tab => {
  const clock = { now: 1_000_000 };

  return { clock, lock: makeDisplayLock(() => clock.now) };
};

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
  ["no time", 0, "Unlocked"],
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

it("keeps a locked display locked through hide and show", () => {
  const { lock } = tabAt();

  lock.hide();
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

it.each([
  [
    "while the page is hidden",
    (tab: Tab, verify: () => void) => {
      tab.clock.now += 1_000;
      verify();
      tab.clock.now += 29_000;
      tab.lock.show();
    },
  ],
  [
    "after the page returns",
    (tab: Tab, verify: () => void) => {
      tab.clock.now += 30_000;
      tab.lock.show();
      verify();
    },
  ],
] as const)(
  "an entry that verifies %s unlocks once the page has been back within the window",
  (_, afterHide) => {
    const tab = tabAt();
    const attempt = tab.lock.attemptEntry();

    tab.lock.hide();
    afterHide(tab, () => tab.lock.entryVerified(attempt));

    expect(tab.lock.state()._tag).toBe("Unlocked");
  },
);

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
  [
    "completes after the page returns from a hidden window",
    (tab: Tab, verify: () => void) => {
      tab.clock.now += resumeWindow;
      tab.lock.show();
      verify();
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

it("an entry that outlasts the hidden window is no longer pending before the page returns", () => {
  const { clock, lock } = tabAt();
  const attempt = lock.attemptEntry();

  lock.hide();
  clock.now += resumeWindow;

  expect(lock.entryPending(attempt)).toBe(false);
});
