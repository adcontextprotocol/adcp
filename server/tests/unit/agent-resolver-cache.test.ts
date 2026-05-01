/**
 * TTL cache + per-host token-bucket rate limiter for the AAO agent
 * resolver. Pure in-memory data structures — exercised directly without
 * touching network or DB.
 */
import { describe, it, expect, vi } from "vitest";
import { TtlCache, TokenBucketRateLimiter } from "../../src/registry/agent-resolver/cache.js";

describe("TtlCache", () => {
  it("returns the stored value before TTL elapses", () => {
    const c = new TtlCache<string>({ defaultTtlMs: 1000 });
    c.set("k", "v", undefined, 1000);
    expect(c.get("k", 1500)).toBe("v");
  });

  it("evicts entries past their TTL", () => {
    const c = new TtlCache<string>({ defaultTtlMs: 1000 });
    c.set("k", "v", undefined, 1000);
    expect(c.get("k", 2001)).toBeUndefined();
    // Confirm the entry was actually deleted (not just hidden).
    expect(c.size()).toBe(0);
  });

  it("respects per-call TTL override", () => {
    const c = new TtlCache<string>({ defaultTtlMs: 60_000 });
    c.set("k", "v", 100, 1000);
    expect(c.get("k", 1050)).toBe("v");
    expect(c.get("k", 1101)).toBeUndefined();
  });

  it("evicts the oldest entry when at capacity", () => {
    const c = new TtlCache<string>({ defaultTtlMs: 60_000, maxEntries: 2 });
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3"); // evicts "a"
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("2");
    expect(c.get("c")).toBe("3");
  });

  it("delete removes the entry", () => {
    const c = new TtlCache<string>({ defaultTtlMs: 1000 });
    c.set("k", "v");
    c.delete("k");
    expect(c.get("k")).toBeUndefined();
  });
});

describe("TokenBucketRateLimiter", () => {
  it("permits up to capacity within the same instant", () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter({
      capacity: 3,
      refillPerSecond: 10,
      now: () => now,
    });
    expect(rl.consume("h")).toBe(true);
    expect(rl.consume("h")).toBe(true);
    expect(rl.consume("h")).toBe(true);
    expect(rl.consume("h")).toBe(false);
  });

  it("denies after N tokens are exhausted", () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter({
      capacity: 10,
      refillPerSecond: 10,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) {
      expect(rl.consume("h")).toBe(true);
    }
    expect(rl.consume("h")).toBe(false);
  });

  it("refills tokens at the configured rate", () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSecond: 10,
      now: () => now,
    });
    expect(rl.consume("h")).toBe(true);
    expect(rl.consume("h")).toBe(true);
    expect(rl.consume("h")).toBe(false);
    // 100 ms = 1 token at 10 rps.
    now = 100;
    expect(rl.consume("h")).toBe(true);
  });

  it("uses separate buckets per key", () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerSecond: 10,
      now: () => now,
    });
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("a")).toBe(false);
    expect(rl.consume("b")).toBe(true);
  });

  it("caps refilled tokens at capacity", () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSecond: 10,
      now: () => now,
    });
    // Drain one.
    rl.consume("h");
    // Wait an absurdly long time — should not exceed capacity.
    now = 10_000;
    expect(rl.consume("h")).toBe(true);
    expect(rl.consume("h")).toBe(true);
    expect(rl.consume("h")).toBe(false);
  });
});
