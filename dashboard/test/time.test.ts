import { expect, it } from "vitest";
import { estimateLaptopNow, secondsUntilReset } from "../src/lib/time.js";
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
