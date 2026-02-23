import { query } from './client.js';
import type { CheckResult } from '../services/property-check.js';

export class PropertyCheckDatabase {
  async saveReport(results: CheckResult): Promise<{ id: string }> {
    const result = await query<{ id: string }>(
      `INSERT INTO property_check_reports (results) VALUES ($1) RETURNING id`,
      [JSON.stringify(results)]
    );
    return { id: result.rows[0].id };
  }

  async getReport(id: string): Promise<CheckResult | null> {
    const result = await query<{ results: unknown }>(
      `SELECT results FROM property_check_reports WHERE id = $1 AND expires_at > NOW()`,
      [id]
    );
    if (!result.rows[0]) return null;
    return result.rows[0].results as CheckResult;
  }
}
