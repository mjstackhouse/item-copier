import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRateLimiter, rateLimiterFor } from "./pacedHttp";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts `count` requests through the limiter and records the fake time each one is let through. */
const startRequests = (waitForTurn: () => Promise<void>, count: number) => {
  const started: number[] = [];
  const all = Promise.all(Array.from({ length: count }, () => waitForTurn().then(() => started.push(Date.now()))));
  return { started, all };
};

/** The most start times within any window of `windowMs`. */
const busiest = (times: readonly number[], windowMs: number) =>
  Math.max(...times.map((t) => times.filter((u) => u >= t && u - t < windowMs).length));

describe("createRateLimiter", () => {
  test("lets the first requests through straight away", async () => {
    const { started, all } = startRequests(createRateLimiter({ perSecond: 5, perMinute: 200 }), 5);
    await vi.advanceTimersByTimeAsync(0);
    await all;
    expect(new Set(started).size).toBe(1);
  });

  test("starts at most 5 requests per second", async () => {
    const { started, all } = startRequests(createRateLimiter({ perSecond: 5, perMinute: 200 }), 23);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(started).toHaveLength(23);
    expect(busiest(started, 1000)).toBeLessThanOrEqual(5);
  });

  test("starts at most 200 requests per minute", async () => {
    const { started, all } = startRequests(createRateLimiter({ perSecond: 1000, perMinute: 200 }), 250);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await all;
    expect(started).toHaveLength(250);
    expect(busiest(started, 60_000)).toBeLessThanOrEqual(200);
  });

  test("lets requests through in the order they asked", async () => {
    const waitForTurn = createRateLimiter({ perSecond: 2, perMinute: 200 });
    const order: number[] = [];
    const all = Promise.all([1, 2, 3, 4, 5].map((n) => waitForTurn().then(() => order.push(n))));
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("rateLimiterFor", () => {
  test("shares one limiter per environment", () => {
    expect(rateLimiterFor("env-a")).toBe(rateLimiterFor("env-a"));
    expect(rateLimiterFor("env-a")).not.toBe(rateLimiterFor("env-b"));
  });
});
