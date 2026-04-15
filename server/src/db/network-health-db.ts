import { query } from "./client.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DomainDetail {
  domain: string;
  pointer_status: "valid" | "missing" | "orphaned" | "stale" | "error";
  matched_property: string | null;
  authorized_agents: string[];
  errors: string[];
}

export interface AgentHealth {
  agent_url: string;
  reachable: boolean;
  response_time_ms: number | null;
  error?: string;
}

export interface NetworkConsistencyReport {
  id: string;
  authoritative_url: string;
  org_id: string | null;
  total_properties: number;
  valid_pointers: number;
  missing_pointers: number;
  orphaned_pointers: number;
  stale_pointers: number;
  schema_errors: number;
  coverage_pct: number;
  domain_details: DomainDetail[];
  agent_health: AgentHealth[];
  schema_error_details: unknown[];
  crawl_id: string | null;
  created_at: Date;
}

export interface NetworkAlertRule {
  id: string;
  authoritative_url: string;
  org_id: string | null;
  coverage_threshold: number;
  stale_pointer_max: number;
  orphaned_pointer_max: number;
  missing_pointer_persistence_cycles: number;
  agent_unreachable_cycles: number;
  slack_webhook_url: string | null;
  email_recipients: string[];
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NetworkAlertHistoryEntry {
  id: string;
  authoritative_url: string;
  alert_type: string;
  severity: string;
  summary: string;
  details: Record<string, unknown>;
  report_id: string | null;
  notified_via: string[];
  resolved_at: Date | null;
  created_at: Date;
}

export interface CreateReportInput {
  authoritative_url: string;
  org_id?: string;
  total_properties: number;
  valid_pointers: number;
  missing_pointers: number;
  orphaned_pointers: number;
  stale_pointers: number;
  schema_errors: number;
  coverage_pct: number;
  domain_details: DomainDetail[];
  agent_health: AgentHealth[];
  schema_error_details?: unknown[];
  crawl_id?: string;
}

export interface UpsertAlertRuleInput {
  authoritative_url: string;
  org_id?: string;
  coverage_threshold?: number;
  stale_pointer_max?: number;
  orphaned_pointer_max?: number;
  missing_pointer_persistence_cycles?: number;
  agent_unreachable_cycles?: number;
  slack_webhook_url?: string | null;
  email_recipients?: string[];
  enabled?: boolean;
  created_by?: string;
}

export interface NetworkSummary {
  authoritative_url: string;
  org_id: string | null;
  coverage_pct: number;
  total_properties: number;
  missing_pointers: number;
  orphaned_pointers: number;
  stale_pointers: number;
  schema_errors: number;
  unresolved_alerts: number;
  last_report_at: Date;
}

// ─── Reports ────────────────────────────────────────────────────────────────

export async function createReport(
  input: CreateReportInput
): Promise<NetworkConsistencyReport> {
  const result = await query<NetworkConsistencyReport>(
    `INSERT INTO network_consistency_reports (
      authoritative_url, org_id, total_properties, valid_pointers,
      missing_pointers, orphaned_pointers, stale_pointers, schema_errors,
      coverage_pct, domain_details, agent_health, schema_error_details, crawl_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *`,
    [
      input.authoritative_url,
      input.org_id ?? null,
      input.total_properties,
      input.valid_pointers,
      input.missing_pointers,
      input.orphaned_pointers,
      input.stale_pointers,
      input.schema_errors,
      input.coverage_pct,
      JSON.stringify(input.domain_details),
      JSON.stringify(input.agent_health),
      JSON.stringify(input.schema_error_details ?? []),
      input.crawl_id ?? null,
    ]
  );
  return result.rows[0];
}

export async function getLatestReport(
  authoritativeUrl: string
): Promise<NetworkConsistencyReport | null> {
  const result = await query<NetworkConsistencyReport>(
    `SELECT * FROM network_consistency_reports
     WHERE authoritative_url = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [authoritativeUrl]
  );
  return result.rows[0] ?? null;
}

export async function getReportHistory(
  authoritativeUrl: string,
  limit = 30
): Promise<NetworkConsistencyReport[]> {
  const result = await query<NetworkConsistencyReport>(
    `SELECT * FROM network_consistency_reports
     WHERE authoritative_url = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [authoritativeUrl, limit]
  );
  return result.rows;
}

export async function getNetworkSummaries(): Promise<NetworkSummary[]> {
  const result = await query<NetworkSummary>(
    `SELECT DISTINCT ON (r.authoritative_url)
       r.authoritative_url,
       r.org_id,
       r.coverage_pct,
       r.total_properties,
       r.missing_pointers,
       r.orphaned_pointers,
       r.stale_pointers,
       r.schema_errors,
       r.created_at AS last_report_at,
       COALESCE(a.unresolved_alerts, 0)::integer AS unresolved_alerts
     FROM network_consistency_reports r
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS unresolved_alerts
       FROM network_alert_history
       WHERE authoritative_url = r.authoritative_url
         AND resolved_at IS NULL
     ) a ON TRUE
     ORDER BY r.authoritative_url, r.created_at DESC`
  );
  return result.rows;
}

// ─── Lightweight queries for alert evaluation ───────────────────────────────

export interface RecentReportMetrics {
  missing_pointers: number;
  agent_health: AgentHealth[];
  created_at: Date;
}

export async function getRecentReportMetrics(
  authoritativeUrl: string,
  limit: number
): Promise<RecentReportMetrics[]> {
  const result = await query<RecentReportMetrics>(
    `SELECT missing_pointers, agent_health, created_at
     FROM network_consistency_reports
     WHERE authoritative_url = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [authoritativeUrl, limit]
  );
  return result.rows;
}

// ─── Trend data (lightweight projection for charts) ─────────────────────────

export interface TrendPoint {
  created_at: Date;
  coverage_pct: number;
  missing_pointers: number;
  orphaned_pointers: number;
  stale_pointers: number;
  schema_errors: number;
}

export async function getTrends(
  authoritativeUrl: string,
  limit = 60
): Promise<TrendPoint[]> {
  const result = await query<TrendPoint>(
    `SELECT created_at, coverage_pct, missing_pointers,
            orphaned_pointers, stale_pointers, schema_errors
     FROM network_consistency_reports
     WHERE authoritative_url = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [authoritativeUrl, limit]
  );
  return result.rows;
}

// ─── Alert rules ────────────────────────────────────────────────────────────

export async function getAlertRule(
  authoritativeUrl: string
): Promise<NetworkAlertRule | null> {
  const result = await query<NetworkAlertRule>(
    `SELECT * FROM network_alert_rules WHERE authoritative_url = $1`,
    [authoritativeUrl]
  );
  return result.rows[0] ?? null;
}

export async function upsertAlertRule(
  input: UpsertAlertRuleInput
): Promise<NetworkAlertRule> {
  const result = await query<NetworkAlertRule>(
    `INSERT INTO network_alert_rules (
      authoritative_url, org_id,
      coverage_threshold, stale_pointer_max, orphaned_pointer_max,
      missing_pointer_persistence_cycles, agent_unreachable_cycles,
      slack_webhook_url, email_recipients, enabled, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (authoritative_url) DO UPDATE SET
      org_id = COALESCE(EXCLUDED.org_id, network_alert_rules.org_id),
      coverage_threshold = EXCLUDED.coverage_threshold,
      stale_pointer_max = EXCLUDED.stale_pointer_max,
      orphaned_pointer_max = EXCLUDED.orphaned_pointer_max,
      missing_pointer_persistence_cycles = EXCLUDED.missing_pointer_persistence_cycles,
      agent_unreachable_cycles = EXCLUDED.agent_unreachable_cycles,
      slack_webhook_url = EXCLUDED.slack_webhook_url,
      email_recipients = EXCLUDED.email_recipients,
      enabled = EXCLUDED.enabled,
      updated_at = NOW()
    RETURNING *`,
    [
      input.authoritative_url,
      input.org_id ?? null,
      input.coverage_threshold ?? 95,
      input.stale_pointer_max ?? 0,
      input.orphaned_pointer_max ?? 0,
      input.missing_pointer_persistence_cycles ?? 2,
      input.agent_unreachable_cycles ?? 2,
      input.slack_webhook_url ?? null,
      input.email_recipients ?? [],
      input.enabled ?? true,
      input.created_by ?? null,
    ]
  );
  return result.rows[0];
}

// ─── Alert history ──────────────────────────────────────────────────────────

export type AlertType =
  | 'coverage_drop'
  | 'orphaned_pointer'
  | 'stale_pointer'
  | 'schema_error'
  | 'agent_unreachable'
  | 'missing_pointer_persistent';

export type AlertSeverity = 'warning' | 'critical';

export interface CreateAlertInput {
  authoritative_url: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  summary: string;
  details?: Record<string, unknown>;
  report_id?: string;
  notified_via?: string[];
}

export async function createAlert(
  input: CreateAlertInput
): Promise<NetworkAlertHistoryEntry> {
  const result = await query<NetworkAlertHistoryEntry>(
    `INSERT INTO network_alert_history (
      authoritative_url, alert_type, severity, summary,
      details, report_id, notified_via
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`,
    [
      input.authoritative_url,
      input.alert_type,
      input.severity,
      input.summary,
      JSON.stringify(input.details ?? {}),
      input.report_id ?? null,
      input.notified_via ?? [],
    ]
  );
  return result.rows[0];
}

export async function getUnresolvedAlerts(
  authoritativeUrl: string
): Promise<NetworkAlertHistoryEntry[]> {
  const result = await query<NetworkAlertHistoryEntry>(
    `SELECT * FROM network_alert_history
     WHERE authoritative_url = $1 AND resolved_at IS NULL
     ORDER BY created_at DESC`,
    [authoritativeUrl]
  );
  return result.rows;
}

export async function getAlertHistory(
  authoritativeUrl: string,
  limit = 50
): Promise<NetworkAlertHistoryEntry[]> {
  const result = await query<NetworkAlertHistoryEntry>(
    `SELECT * FROM network_alert_history
     WHERE authoritative_url = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [authoritativeUrl, limit]
  );
  return result.rows;
}

export async function resolveAlert(alertId: string): Promise<void> {
  await query(
    `UPDATE network_alert_history SET resolved_at = NOW() WHERE id = $1`,
    [alertId]
  );
}

export async function resolveAlertsByType(
  authoritativeUrl: string,
  alertType: string
): Promise<void> {
  await query(
    `UPDATE network_alert_history
     SET resolved_at = NOW()
     WHERE authoritative_url = $1 AND alert_type = $2 AND resolved_at IS NULL`,
    [authoritativeUrl, alertType]
  );
}

// ─── Alert evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate a new report against the alert rules for its authoritative URL.
 * Returns alerts that should be fired (caller is responsible for persisting
 * and sending notifications).
 */
export async function evaluateAlerts(
  report: NetworkConsistencyReport
): Promise<CreateAlertInput[]> {
  const rule = await getAlertRule(report.authoritative_url);
  if (!rule || !rule.enabled) return [];

  const alerts: CreateAlertInput[] = [];

  // Coverage drop
  if (report.coverage_pct < rule.coverage_threshold) {
    alerts.push({
      authoritative_url: report.authoritative_url,
      alert_type: "coverage_drop",
      severity: "critical",
      summary: `Coverage dropped to ${report.coverage_pct}% (threshold: ${rule.coverage_threshold}%)`,
      report_id: report.id,
    });
  }

  // Schema errors (always critical)
  if (report.schema_errors > 0) {
    alerts.push({
      authoritative_url: report.authoritative_url,
      alert_type: "schema_error",
      severity: "critical",
      summary: `${report.schema_errors} schema validation error(s) in authoritative file`,
      details: { errors: report.schema_error_details },
      report_id: report.id,
    });
  }

  // Orphaned pointers
  if (report.orphaned_pointers > rule.orphaned_pointer_max) {
    alerts.push({
      authoritative_url: report.authoritative_url,
      alert_type: "orphaned_pointer",
      severity: "warning",
      summary: `${report.orphaned_pointers} orphaned pointer(s) detected`,
      report_id: report.id,
    });
  }

  // Stale pointers
  if (report.stale_pointers > rule.stale_pointer_max) {
    alerts.push({
      authoritative_url: report.authoritative_url,
      alert_type: "stale_pointer",
      severity: "warning",
      summary: `${report.stale_pointers} stale pointer(s) detected`,
      report_id: report.id,
    });
  }

  // Agent unreachability (check consecutive failures using lightweight query)
  const unreachableAgents = report.agent_health.filter((a) => !a.reachable);
  if (unreachableAgents.length > 0) {
    const metrics = await getRecentReportMetrics(
      report.authoritative_url,
      rule.agent_unreachable_cycles
    );
    for (const agent of unreachableAgents) {
      const consecutiveFailures = metrics.filter((h) =>
        h.agent_health.some(
          (a: AgentHealth) => a.agent_url === agent.agent_url && !a.reachable
        )
      ).length;

      if (consecutiveFailures >= rule.agent_unreachable_cycles) {
        alerts.push({
          authoritative_url: report.authoritative_url,
          alert_type: "agent_unreachable",
          severity: "warning",
          summary: `Agent ${agent.agent_url} unreachable for ${consecutiveFailures} consecutive cycles`,
          details: { agent_url: agent.agent_url, cycles: consecutiveFailures },
          report_id: report.id,
        });
      }
    }
  }

  // Missing pointer persistence (using lightweight query)
  if (report.missing_pointers > 0) {
    const metrics = await getRecentReportMetrics(
      report.authoritative_url,
      rule.missing_pointer_persistence_cycles
    );
    const persistentCount = metrics.filter(
      (h) => h.missing_pointers > 0
    ).length;

    if (persistentCount >= rule.missing_pointer_persistence_cycles) {
      alerts.push({
        authoritative_url: report.authoritative_url,
        alert_type: "missing_pointer_persistent",
        severity: "warning",
        summary: `${report.missing_pointers} missing pointer(s) persisting for ${persistentCount} cycles`,
        report_id: report.id,
      });
    }
  }

  return alerts;
}
