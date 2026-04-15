import { query } from "./client.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PropertyRelationship = "owned" | "direct" | "delegated" | "ad_network";
export type VerificationStatus = "verified" | "missing_authorization" | "orphaned" | "unreachable" | "error";

export interface PropertyDetail {
  identifier: string;
  type: string;
  relationship: PropertyRelationship;
  verification_status: VerificationStatus;
  agent_authorized: boolean;
  errors: string[];
}

export interface AgentHealth {
  agent_url: string;
  agent_id: string;
  reachable: boolean;
  response_time_ms: number | null;
  error?: string;
}

export interface NetworkConsistencyReport {
  id: string;
  org_id: string;
  brand_domain: string;
  total_properties: number;
  verified_properties: number;
  missing_authorization: number;
  orphaned_authorization: number;
  schema_errors: number;
  coverage_pct: number;
  property_details: PropertyDetail[];
  agent_health: AgentHealth[];
  schema_error_details: unknown[];
  crawl_id: string | null;
  created_at: Date;
}

export interface NetworkAlertRule {
  id: string;
  org_id: string;
  coverage_threshold: number;
  missing_authorization_max: number;
  orphaned_authorization_max: number;
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
  org_id: string;
  alert_type: string;
  severity: string;
  summary: string;
  details: Record<string, unknown>;
  report_id: string | null;
  notified_via: string[];
  resolved_at: Date | null;
  created_at: Date;
}

export type AlertType =
  | "coverage_drop"
  | "missing_authorization"
  | "orphaned_authorization"
  | "schema_error"
  | "agent_unreachable";

export type AlertSeverity = "warning" | "critical";

export interface CreateReportInput {
  org_id: string;
  brand_domain: string;
  total_properties: number;
  verified_properties: number;
  missing_authorization: number;
  orphaned_authorization: number;
  schema_errors: number;
  coverage_pct: number;
  property_details: PropertyDetail[];
  agent_health: AgentHealth[];
  schema_error_details?: unknown[];
  crawl_id?: string;
}

export interface UpsertAlertRuleInput {
  org_id: string;
  coverage_threshold?: number;
  missing_authorization_max?: number;
  orphaned_authorization_max?: number;
  agent_unreachable_cycles?: number;
  slack_webhook_url?: string | null;
  email_recipients?: string[];
  enabled?: boolean;
  created_by?: string;
}

export interface CreateAlertInput {
  org_id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  summary: string;
  details?: Record<string, unknown>;
  report_id?: string;
  notified_via?: string[];
}

export interface NetworkSummary {
  org_id: string;
  brand_domain: string;
  coverage_pct: number;
  total_properties: number;
  verified_properties: number;
  missing_authorization: number;
  orphaned_authorization: number;
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
      org_id, brand_domain, total_properties, verified_properties,
      missing_authorization, orphaned_authorization, schema_errors,
      coverage_pct, property_details, agent_health, schema_error_details, crawl_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [
      input.org_id,
      input.brand_domain,
      input.total_properties,
      input.verified_properties,
      input.missing_authorization,
      input.orphaned_authorization,
      input.schema_errors,
      input.coverage_pct,
      JSON.stringify(input.property_details),
      JSON.stringify(input.agent_health),
      JSON.stringify(input.schema_error_details ?? []),
      input.crawl_id ?? null,
    ]
  );
  return result.rows[0];
}

export async function getLatestReport(
  orgId: string
): Promise<NetworkConsistencyReport | null> {
  const result = await query<NetworkConsistencyReport>(
    `SELECT * FROM network_consistency_reports
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId]
  );
  return result.rows[0] ?? null;
}

export async function getReportHistory(
  orgId: string,
  limit = 30
): Promise<NetworkConsistencyReport[]> {
  const result = await query<NetworkConsistencyReport>(
    `SELECT * FROM network_consistency_reports
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [orgId, limit]
  );
  return result.rows;
}

export async function getNetworkSummaries(): Promise<NetworkSummary[]> {
  const result = await query<NetworkSummary>(
    `SELECT DISTINCT ON (r.org_id)
       r.org_id,
       r.brand_domain,
       r.coverage_pct,
       r.total_properties,
       r.verified_properties,
       r.missing_authorization,
       r.orphaned_authorization,
       r.schema_errors,
       r.created_at AS last_report_at,
       COALESCE(a.unresolved_alerts, 0)::integer AS unresolved_alerts
     FROM network_consistency_reports r
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS unresolved_alerts
       FROM network_alert_history
       WHERE org_id = r.org_id
         AND resolved_at IS NULL
     ) a ON TRUE
     ORDER BY r.org_id, r.created_at DESC`
  );
  return result.rows;
}

// ─── Lightweight queries for alert evaluation ───────────────────────────────

export interface RecentReportMetrics {
  missing_authorization: number;
  agent_health: AgentHealth[];
  created_at: Date;
}

export async function getRecentReportMetrics(
  orgId: string,
  limit: number
): Promise<RecentReportMetrics[]> {
  const result = await query<RecentReportMetrics>(
    `SELECT missing_authorization, agent_health, created_at
     FROM network_consistency_reports
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [orgId, limit]
  );
  return result.rows;
}

// ─── Trend data (lightweight projection for charts) ─────────────────────────

export interface TrendPoint {
  created_at: Date;
  coverage_pct: number;
  verified_properties: number;
  missing_authorization: number;
  orphaned_authorization: number;
  schema_errors: number;
}

export async function getTrends(
  orgId: string,
  limit = 60
): Promise<TrendPoint[]> {
  const result = await query<TrendPoint>(
    `SELECT created_at, coverage_pct, verified_properties,
            missing_authorization, orphaned_authorization, schema_errors
     FROM network_consistency_reports
     WHERE org_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [orgId, limit]
  );
  return result.rows;
}

// ─── Alert rules ────────────────────────────────────────────────────────────

export async function getAlertRule(
  orgId: string
): Promise<NetworkAlertRule | null> {
  const result = await query<NetworkAlertRule>(
    `SELECT * FROM network_alert_rules WHERE org_id = $1`,
    [orgId]
  );
  return result.rows[0] ?? null;
}

export async function upsertAlertRule(
  input: UpsertAlertRuleInput
): Promise<NetworkAlertRule> {
  const result = await query<NetworkAlertRule>(
    `INSERT INTO network_alert_rules (
      org_id, coverage_threshold, missing_authorization_max,
      orphaned_authorization_max, agent_unreachable_cycles,
      slack_webhook_url, email_recipients, enabled, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (org_id) DO UPDATE SET
      coverage_threshold = EXCLUDED.coverage_threshold,
      missing_authorization_max = EXCLUDED.missing_authorization_max,
      orphaned_authorization_max = EXCLUDED.orphaned_authorization_max,
      agent_unreachable_cycles = EXCLUDED.agent_unreachable_cycles,
      slack_webhook_url = EXCLUDED.slack_webhook_url,
      email_recipients = EXCLUDED.email_recipients,
      enabled = EXCLUDED.enabled,
      updated_at = NOW()
    RETURNING *`,
    [
      input.org_id,
      input.coverage_threshold ?? 95,
      input.missing_authorization_max ?? 0,
      input.orphaned_authorization_max ?? 0,
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

export async function createAlert(
  input: CreateAlertInput
): Promise<NetworkAlertHistoryEntry> {
  const result = await query<NetworkAlertHistoryEntry>(
    `INSERT INTO network_alert_history (
      org_id, alert_type, severity, summary,
      details, report_id, notified_via
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`,
    [
      input.org_id,
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
  orgId: string
): Promise<NetworkAlertHistoryEntry[]> {
  const result = await query<NetworkAlertHistoryEntry>(
    `SELECT * FROM network_alert_history
     WHERE org_id = $1 AND resolved_at IS NULL
     ORDER BY created_at DESC`,
    [orgId]
  );
  return result.rows;
}

export async function getAlertHistory(
  orgId: string,
  limit = 50
): Promise<NetworkAlertHistoryEntry[]> {
  const result = await query<NetworkAlertHistoryEntry>(
    `SELECT * FROM network_alert_history
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [orgId, limit]
  );
  return result.rows;
}

export async function resolveAlert(alertId: string): Promise<void> {
  await query(
    `UPDATE network_alert_history SET resolved_at = NOW() WHERE id = $1`,
    [alertId]
  );
}

// ─── Alert evaluation ───────────────────────────────────────────────────────

export async function evaluateAlerts(
  report: NetworkConsistencyReport
): Promise<CreateAlertInput[]> {
  const rule = await getAlertRule(report.org_id);
  if (!rule || !rule.enabled) return [];

  const alerts: CreateAlertInput[] = [];

  // Coverage drop
  if (report.coverage_pct < rule.coverage_threshold) {
    alerts.push({
      org_id: report.org_id,
      alert_type: "coverage_drop",
      severity: "critical",
      summary: `Coverage dropped to ${report.coverage_pct}% (threshold: ${rule.coverage_threshold}%)`,
      report_id: report.id,
    });
  }

  // Schema errors (always critical)
  if (report.schema_errors > 0) {
    alerts.push({
      org_id: report.org_id,
      alert_type: "schema_error",
      severity: "critical",
      summary: `${report.schema_errors} schema validation error(s) in brand.json`,
      details: { errors: report.schema_error_details },
      report_id: report.id,
    });
  }

  // Missing authorization
  if (report.missing_authorization > rule.missing_authorization_max) {
    alerts.push({
      org_id: report.org_id,
      alert_type: "missing_authorization",
      severity: "warning",
      summary: `${report.missing_authorization} declared property/properties not yet authorized in publisher adagents.json`,
      report_id: report.id,
    });
  }

  // Orphaned authorization
  if (report.orphaned_authorization > rule.orphaned_authorization_max) {
    alerts.push({
      org_id: report.org_id,
      alert_type: "orphaned_authorization",
      severity: "warning",
      summary: `${report.orphaned_authorization} publisher authorization(s) not declared in brand.json`,
      report_id: report.id,
    });
  }

  // Agent unreachability (check consecutive failures)
  const unreachableAgents = report.agent_health.filter((a) => !a.reachable);
  if (unreachableAgents.length > 0) {
    const metrics = await getRecentReportMetrics(
      report.org_id,
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
          org_id: report.org_id,
          alert_type: "agent_unreachable",
          severity: "warning",
          summary: `Agent ${agent.agent_url} unreachable for ${consecutiveFailures} consecutive cycles`,
          details: { agent_url: agent.agent_url, cycles: consecutiveFailures },
          report_id: report.id,
        });
      }
    }
  }

  return alerts;
}
