/**
 * The date a newsletter edition is shown under.
 *
 * `edition_date` is the internal key (URLs, cover path, feedback links) and is
 * set when the draft is generated. Readers should see the date the edition
 * actually goes out: two editions went out 9 and 10 days after the date in
 * their header. These helpers pick the date to print; callers keep passing
 * `edition_date` wherever it is used as a key.
 */

const ET_TIME_ZONE = 'America/New_York';

/** YYYY-MM-DD for the given instant, in US Eastern time. */
export function etDateString(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function toDateKey(value: Date | string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(value).toISOString().split('T')[0];
}

/**
 * The date an unsent edition will go out: its edition date if that is still
 * ahead, otherwise today. Approved editions whose slot has passed are sent on
 * the scheduler's next run, so "today" is the honest answer for those, and
 * for previews and test sends of a late draft.
 */
export function plannedSendDate(editionDate: Date | string, now: Date = new Date()): string {
  const edition = toDateKey(editionDate);
  const today = etDateString(now);
  return edition > today ? edition : today;
}

/**
 * Date to print in an edition's header: the actual send date once sent,
 * otherwise the planned send date.
 */
export function editionDisplayDate(
  edition: { edition_date: Date | string; sent_at?: Date | string | null },
  now: Date = new Date(),
): string {
  if (edition.sent_at) return etDateString(new Date(edition.sent_at));
  return plannedSendDate(edition.edition_date, now);
}
