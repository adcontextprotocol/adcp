import { describe, it, expect } from 'vitest';
import { parse as parseCsvLib } from 'csv-parse/sync';

/**
 * Zoom Participant Report CSV Import Tests
 *
 * Tests the CSV parsing and deduplication logic for Zoom participant reports.
 * Zoom exports vary across versions, so column normalization is critical.
 */

// Extracted from events.ts for unit testing
interface ZoomCsvRow {
  name: string;
  email: string;
  join_time: string;
  leave_time: string;
  duration_minutes: string;
}

function parseZoomCsv(csvContent: string): ZoomCsvRow[] {
  const records: Record<string, string>[] = parseCsvLib(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  return records.map(row => {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      const k = key.toLowerCase().trim()
        .replace(/[()]/g, '')
        .replace(/\s+/g, '_');
      normalized[k] = value;
    }

    return {
      name: normalized['name_original_name'] || normalized['name'] || normalized['user_name'] || '',
      email: normalized['user_email'] || normalized['email'] || '',
      join_time: normalized['join_time'] || normalized['joined'] || '',
      leave_time: normalized['leave_time'] || normalized['left'] || '',
      duration_minutes: normalized['duration_minutes'] || normalized['duration'] || '',
    };
  });
}

function parseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return undefined;
  return date;
}

// Deduplication logic extracted for testing
function deduplicateZoomRows(rows: ZoomCsvRow[]): Map<string, { name: string; joinTime: Date | undefined; leaveTime: Date | undefined; totalMinutes: number }> {
  const byEmail = new Map<string, { name: string; joinTime: Date | undefined; leaveTime: Date | undefined; totalMinutes: number }>();

  for (const row of rows) {
    if (!row.email) continue;
    const email = row.email.toLowerCase().trim();
    if (!email.includes('@') || email.length < 5 || !email.includes('.')) continue;

    const joinTime = parseDate(row.join_time);
    const leaveTime = parseDate(row.leave_time);
    const minutes = parseInt(row.duration_minutes, 10) || 0;

    const existing = byEmail.get(email);
    if (existing) {
      if (joinTime && (!existing.joinTime || joinTime < existing.joinTime)) {
        existing.joinTime = joinTime;
      }
      if (leaveTime && (!existing.leaveTime || leaveTime > existing.leaveTime)) {
        existing.leaveTime = leaveTime;
      }
      existing.totalMinutes += minutes;
      if (!existing.name && row.name) {
        existing.name = row.name;
      }
    } else {
      byEmail.set(email, { name: row.name, joinTime, leaveTime, totalMinutes: minutes });
    }
  }

  return byEmail;
}

describe('Zoom CSV Import', () => {
  describe('parseZoomCsv', () => {
    it('parses standard Zoom participant report format', () => {
      const csv = `Name (Original Name),User Email,Join Time,Leave Time,Duration (Minutes)
Anne Coghlan,anne@example.com,2026-03-20T14:00:00Z,2026-03-20T15:30:00Z,90
Brian O'Kelley,brian@example.com,2026-03-20T14:02:00Z,2026-03-20T15:28:00Z,86`;

      const rows = parseZoomCsv(csv);

      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe('Anne Coghlan');
      expect(rows[0].email).toBe('anne@example.com');
      expect(rows[0].join_time).toBe('2026-03-20T14:00:00Z');
      expect(rows[0].leave_time).toBe('2026-03-20T15:30:00Z');
      expect(rows[0].duration_minutes).toBe('90');
    });

    it('handles alternative Zoom column names', () => {
      const csv = `User Name,Email,Joined,Left,Duration
Lars Postmus,lars@example.com,2026-03-20T14:00:00Z,2026-03-20T15:00:00Z,60`;

      const rows = parseZoomCsv(csv);

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Lars Postmus');
      expect(rows[0].email).toBe('lars@example.com');
      expect(rows[0].duration_minutes).toBe('60');
    });

    it('handles BOM and extra whitespace in headers', () => {
      const csv = `\uFEFF Name (Original Name) , User Email , Join Time , Leave Time , Duration (Minutes)
Test User,test@example.com,2026-03-20T14:00:00Z,2026-03-20T15:00:00Z,60`;

      const rows = parseZoomCsv(csv);

      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('test@example.com');
    });

    it('returns empty array for empty CSV', () => {
      const csv = `Name (Original Name),User Email,Join Time,Leave Time,Duration (Minutes)`;
      const rows = parseZoomCsv(csv);
      expect(rows).toHaveLength(0);
    });
  });

  describe('deduplication', () => {
    it('merges multiple sessions from the same person', () => {
      const rows: ZoomCsvRow[] = [
        { name: 'Anne Coghlan', email: 'anne@example.com', join_time: '2026-03-20T14:00:00Z', leave_time: '2026-03-20T14:45:00Z', duration_minutes: '45' },
        { name: 'Anne Coghlan', email: 'anne@example.com', join_time: '2026-03-20T14:50:00Z', leave_time: '2026-03-20T15:30:00Z', duration_minutes: '40' },
      ];

      const result = deduplicateZoomRows(rows);

      expect(result.size).toBe(1);
      const anne = result.get('anne@example.com')!;
      expect(anne.totalMinutes).toBe(85);
      expect(anne.joinTime).toEqual(new Date('2026-03-20T14:00:00Z')); // earliest
      expect(anne.leaveTime).toEqual(new Date('2026-03-20T15:30:00Z')); // latest
    });

    it('handles case-insensitive email matching', () => {
      const rows: ZoomCsvRow[] = [
        { name: 'Test User', email: 'Test@Example.COM', join_time: '2026-03-20T14:00:00Z', leave_time: '2026-03-20T15:00:00Z', duration_minutes: '60' },
        { name: 'Test User', email: 'test@example.com', join_time: '2026-03-20T15:05:00Z', leave_time: '2026-03-20T15:30:00Z', duration_minutes: '25' },
      ];

      const result = deduplicateZoomRows(rows);

      expect(result.size).toBe(1);
      expect(result.get('test@example.com')!.totalMinutes).toBe(85);
    });

    it('skips rows with invalid emails', () => {
      const rows: ZoomCsvRow[] = [
        { name: 'No Email', email: '', join_time: '2026-03-20T14:00:00Z', leave_time: '2026-03-20T15:00:00Z', duration_minutes: '60' },
        { name: 'Bad Email', email: 'not-an-email', join_time: '2026-03-20T14:00:00Z', leave_time: '2026-03-20T15:00:00Z', duration_minutes: '60' },
        { name: 'Good User', email: 'good@example.com', join_time: '2026-03-20T14:00:00Z', leave_time: '2026-03-20T15:00:00Z', duration_minutes: '60' },
      ];

      const result = deduplicateZoomRows(rows);

      expect(result.size).toBe(1);
      expect(result.has('good@example.com')).toBe(true);
    });

    it('preserves name from first row with a name', () => {
      const rows: ZoomCsvRow[] = [
        { name: '', email: 'user@example.com', join_time: '2026-03-20T14:00:00Z', leave_time: '2026-03-20T14:30:00Z', duration_minutes: '30' },
        { name: 'Real Name', email: 'user@example.com', join_time: '2026-03-20T14:35:00Z', leave_time: '2026-03-20T15:00:00Z', duration_minutes: '25' },
      ];

      const result = deduplicateZoomRows(rows);

      expect(result.get('user@example.com')!.name).toBe('Real Name');
    });

    it('handles missing date fields gracefully', () => {
      const rows: ZoomCsvRow[] = [
        { name: 'User', email: 'user@example.com', join_time: '', leave_time: '', duration_minutes: '60' },
      ];

      const result = deduplicateZoomRows(rows);
      const user = result.get('user@example.com')!;

      expect(user.joinTime).toBeUndefined();
      expect(user.leaveTime).toBeUndefined();
      expect(user.totalMinutes).toBe(60);
    });
  });
});
