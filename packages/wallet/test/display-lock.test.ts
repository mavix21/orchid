import { expect, it } from "@effect/vitest";
import { type DisplayLock, makeDisplayLock } from "../src/device/display-lock";

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

const resumeWindow = 60_000;

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
  const { clock, lock } = lockAt();

  unlocked(lock);
  lock.hide();

  expect(lock.state()._tag).toBe("Masked");

  clock.now += resumeWindow - 1;
  lock.hide();
  clock.now += resumeWindow - 1;
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

  expect(lock.valid(ticket)).toBe(true);

  lock.hide();
  lock.show();
  lock.unlock(ticket);

  expect(lock.valid(ticket)).toBe(false);

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
