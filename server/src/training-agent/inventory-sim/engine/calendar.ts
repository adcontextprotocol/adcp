/** Season days. Day 0 is the season's `start_date`, in UTC. */

export const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight UTC of a `YYYY-MM-DD` date, in milliseconds. */
export function parseDate(date: string): number {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new Error(`Not a calendar date: ${date}`);
  return ms;
}

export class SeasonCalendar {
  readonly startMs: number;

  constructor(startDate: string, readonly days: number) {
    this.startMs = parseDate(startDate);
  }

  /** The season day an instant falls on. May be negative or past the end. */
  dayOf(atMs: number): number {
    return Math.floor((atMs - this.startMs) / DAY_MS);
  }

  dayOfDate(date: string): number {
    return this.dayOf(parseDate(date));
  }

  dateOf(day: number): string {
    return new Date(this.startMs + day * DAY_MS).toISOString().slice(0, 10);
  }

  /** Midnight UTC starting the day, as an ISO instant. */
  startOf(day: number): string {
    return new Date(this.startMs + day * DAY_MS).toISOString();
  }

  /** UTC calendar month of a day, 0 for January. */
  month(day: number): number {
    return new Date(this.startMs + day * DAY_MS).getUTCMonth();
  }

  weekday(day: number): number {
    return new Date(this.startMs + day * DAY_MS).getUTCDay();
  }

  inSeason(day: number): boolean {
    return day >= 0 && day < this.days;
  }
}
