import { expect, it } from "@effect/vitest";
import {
  type DisplayLock,
  makeDisplayLock,
  resumeWindowMillis,
} from "../src/device/display-lock";

const lockAt = () => {
  const clock = { now: 1_000_000 };

  return { clock, lock: makeDisplayLock(() => clock.now) };
};

const unlocked = (lock: DisplayLock) => lock.unlock(lock.begin());

const awayFor = (milliseconds: number) => {
  const { clock, lock } = lockAt();

  unlocked(lock);
  lock.hide();
  clock.now += milliseconds;
  lock.show();

  return lock.state()._tag;
};

it("starts locked and unlocks only through a ticket begun in this tab", () => {
  const { lock } = lockAt();

  expect(lock.state()._tag).toBe("Locked");

  unlocked(lock);

  expect(lock.state()._tag).toBe("Unlocked");
});

it.each([
  ["a moment", 1, "Unlocked"],
  ["just under the resume window", resumeWindowMillis - 1, "Unlocked"],
  ["exactly the resume window", resumeWindowMillis, "Locked"],
  ["longer than the resume window", resumeWindowMillis * 5, "Locked"],
  ["a clock set backwards", -1, "Locked"],
] as const)(
  "after being away for %s the display is %s",
  (_, away, expected) => {
    expect(awayFor(away)).toBe(expected);
  },
);

it("masks on hide and never counts a later hide as the start of the absence", () => {
  const { clock, lock } = lockAt();

  unlocked(lock);
  lock.hide();

  expect(lock.state()._tag).toBe("Masked");

  clock.now += resumeWindowMillis - 1;
  lock.hide();
  clock.now += resumeWindowMillis - 1;
  lock.show();

  expect(lock.state()._tag).toBe("Locked");
});

it("keeps a locked display locked through hide and show", () => {
  const { lock } = lockAt();

  lock.hide();
  lock.show();

  expect(lock.state()._tag).toBe("Locked");
});

it("refuses a verification that completes after the page was hidden", () => {
  const { lock } = lockAt();
  const ticket = lock.begin();

  lock.hide();
  lock.show();
  lock.unlock(ticket);

  expect(lock.state()._tag).toBe("Locked");
});

it("locks a restored page without a resume window and refuses its earlier verification", () => {
  const { lock } = lockAt();

  unlocked(lock);

  const ticket = lock.begin();

  lock.hide();
  lock.relock();
  lock.show();
  lock.unlock(ticket);

  expect(lock.state()._tag).toBe("Locked");
});

it("notifies subscribers only when the display changes", () => {
  const { lock } = lockAt();
  let notified = 0;

  const unsubscribe = lock.subscribe(() => {
    notified += 1;
  });

  unlocked(lock);
  unlocked(lock);
  lock.hide();
  lock.show();
  unsubscribe();
  lock.relock();

  expect(notified).toBe(3);
});
