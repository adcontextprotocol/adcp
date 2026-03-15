/**
 * SimulationClock — virtual time for simulation tests.
 *
 * Patches Date.now() so all production code sees the simulated time.
 * For PostgreSQL NOW(), use setSessionTime() to sync the DB clock.
 */

import { vi } from 'vitest';

export class SimulationClock {
  private currentTime: Date;
  private dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;

  constructor(startTime: Date = new Date('2026-03-15T10:00:00Z')) {
    this.currentTime = new Date(startTime);
  }

  /** Install the clock — patches Date.now() and new Date(). */
  install(): void {
    const self = this;
    this.dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => self.currentTime.getTime());

    // Also patch the Date constructor for `new Date()` (no args)
    const OrigDate = globalThis.Date;
    const clock = this;
    const PatchedDate = function (...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        return new OrigDate(clock.currentTime.getTime());
      }
      // @ts-expect-error — spreading constructor args
      return new OrigDate(...args);
    } as unknown as DateConstructor;

    PatchedDate.now = () => self.currentTime.getTime();
    PatchedDate.parse = OrigDate.parse;
    PatchedDate.UTC = OrigDate.UTC;
    PatchedDate.prototype = OrigDate.prototype;

    globalThis.Date = PatchedDate;
    // Store original for restore
    (globalThis as Record<string, unknown>).__origDate = OrigDate;
  }

  /** Uninstall the clock — restores real Date. */
  uninstall(): void {
    if (this.dateNowSpy) {
      this.dateNowSpy.mockRestore();
      this.dateNowSpy = null;
    }
    const orig = (globalThis as Record<string, unknown>).__origDate as DateConstructor | undefined;
    if (orig) {
      globalThis.Date = orig;
      delete (globalThis as Record<string, unknown>).__origDate;
    }
  }

  /** Current simulated time. */
  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  /** Current time as epoch ms. */
  nowMs(): number {
    return this.currentTime.getTime();
  }

  /** Advance time by a duration. Returns the new time. */
  advance(duration: { days?: number; hours?: number; minutes?: number; seconds?: number }): Date {
    const ms =
      (duration.days ?? 0) * 86400000 +
      (duration.hours ?? 0) * 3600000 +
      (duration.minutes ?? 0) * 60000 +
      (duration.seconds ?? 0) * 1000;
    this.currentTime = new Date(this.currentTime.getTime() + ms);
    return this.now();
  }

  /** Set absolute time. */
  setTime(time: Date): void {
    this.currentTime = new Date(time.getTime());
  }
}
