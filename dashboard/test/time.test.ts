import { describe, expect, it } from "vitest";
import { countdown, durationWords, estimateLaptopNow, secondsUntilReset } from "../src/lib/time.js";
it("uses sampled laptop time despite phone wall clock skew", () => {
  expect(
    secondsUntilReset(1005, estimateLaptopNow(1_000_000, 0, 500, 2500)),
  ).toBe(3);
});
it("adds exact cached age across renderer recreation and clamps due reset", () => {
  expect(estimateLaptopNow(1_000_000, 1_800_000, 5, 5)).toBe(2_800_000);
  expect(secondsUntilReset(0, 2000)).toBe(0);
  expect(secondsUntilReset(null, 2000)).toBeNull();
  expect(estimateLaptopNow(1000, 0, 100, 0)).toBe(1000);
});

describe("hours and days", () => {
  it("counts down in days and hours once a reset is a day or more away", () => {
    expect(countdown(86399)).toBe("Reset in 23h 59m");
    expect(countdown(86400)).toBe("Reset in 1d 0h");
    expect(countdown(4 * 86400 + 3 * 3600 + 59)).toBe("Reset in 4d 3h");
  });
  it("names window lengths in words", () => {
    expect(durationWords(45)).toBe("45 minutes");
    expect(durationWords(60)).toBe("1 hour");
    expect(durationWords(300)).toBe("5 hours");
    expect(durationWords(90)).toBe("1 hour 30 minutes");
    expect(durationWords(1440)).toBe("1 day");
    expect(durationWords(10080)).toBe("7 days");
    expect(durationWords(1500)).toBe("1 day 1 hour");
    expect(durationWords(0)).toBe("0 minutes");
  });
});
