/**
 * Network consistency reporter.
 *
 * Compares brand.json property declarations against adagents.json crawl results
 * from the federated index. Produces consistency reports and evaluates alert rules.
 *
 * Data flow:
 *   brand.json (expected) → properties with relationship field
 *   federated index (actual) → agent_publisher_authorizations from crawl
 *   delta → network_consistency_reports
 */

import { query } from '../db/client.js';
import { BrandDatabase } from '../db/brand-db.js';
import type { HostedBrand } from '../types.js';
import { FederatedIndexDatabase, type AgentPublisherAuthorization } from '../db/federated-index-db.js';
import { MemberDatabase } from '../db/member-db.js';
import { getRequestLog } from '../db/outbound-log-db.js';
import * as networkHealthDb from '../db/network-health-db.js';
import { dispatchNetworkAlerts } from '../notifications/network-health.js';
import { createLogger } from '../logger.js';
import type {
  PropertyDetail,
  PropertyRelationship,
  VerificationStatus,
  AgentHealth,
} from '../db/network-health-db.js';

const logger = createLogger('network-consistency-reporter');

const brandDb = new BrandDatabase();
const federatedIndexDb = new FederatedIndexDatabase();
const memberDb = new MemberDatabase();

// ─── Types ──────────────────────────────────────────────────────────────────

interface DeclaredProperty {
  identifier: string;
  type: string;
  relationship: PropertyRelationship;
}

interface ReportResult {
  generated: number;
  skipped: number;
  failed: number;
  alerts_fired: number;
}

// ─── Property extraction ────────────────────────────────────────────────────

/**
 * Extract declared properties from a brand.json structure.
 * Walks brands[].properties[] and collects identifier, type, and relationship.
 */
function extractDeclaredProperties(brandJson: Record<string, unknown>): DeclaredProperty[] {
  const properties: DeclaredProperty[] = [];

  const brands = Array.isArray(brandJson.brands) ? brandJson.brands : [];
  for (const brand of brands) {
    if (!brand || typeof brand !== 'object') continue;
    const brandObj = brand as Record<string, unknown>;
    const props = Array.isArray(brandObj.properties) ? brandObj.properties : [];

    for (const p of props) {
      if (!p || typeof p !== 'object') continue;
      const prop = p as Record<string, unknown>;
      if (typeof prop.identifier !== 'string' || !prop.identifier) continue;

      properties.push({
        identifier: prop.identifier,
        type: typeof prop.type === 'string' ? prop.type : 'website',
        relationship: isValidRelationship(prop.relationship) ? prop.relationship : 'owned',
      });
    }
  }

  return properties;
}

function isValidRelationship(v: unknown): v is PropertyRelationship {
  return v === 'owned' || v === 'direct' || v === 'delegated' || v === 'ad_network';
}

// ─── Single-org report generation ───────────────────────────────────────────

async function generateReportForOrg(
  orgId: string,
  brand: HostedBrand,
  orgAgentUrls: string[]
): Promise<{ report: networkHealthDb.NetworkConsistencyReport; alertsFired: number }> {
  const brandJson = brand.brand_json as Record<string, unknown>;
  const declared = extractDeclaredProperties(brandJson);

  // Build a set of domains the org's agents are authorized for (from crawl)
  const authorizedDomains = new Map<string, AgentPublisherAuthorization[]>();
  for (const agentUrl of orgAgentUrls) {
    const auths = await federatedIndexDb.getDomainsForAgent(agentUrl);
    for (const auth of auths) {
      const existing = authorizedDomains.get(auth.publisher_domain) ?? [];
      existing.push(auth);
      authorizedDomains.set(auth.publisher_domain, existing);
    }
  }

  // Evaluate each declared property
  const propertyDetails: PropertyDetail[] = [];

  for (const prop of declared) {
    // Only website properties have domain identifiers we can verify
    if (prop.type !== 'website') {
      propertyDetails.push({
        identifier: prop.identifier,
        type: prop.type,
        relationship: prop.relationship,
        verification_status: 'verified', // Non-web properties can't be crawl-verified
        agent_authorized: false,
        errors: [],
      });
      continue;
    }

    const domain = prop.identifier.toLowerCase();
    let status: VerificationStatus;
    let agentAuthorized = false;
    const errors: string[] = [];

    if (prop.relationship === 'owned') {
      // For owned properties: check adagents.json exists and is valid
      const hasAdagents = await federatedIndexDb.hasValidAdagents(domain);
      if (hasAdagents === true) {
        status = 'verified';
        // Also check if our agents are authorized
        const domainAuths = authorizedDomains.get(domain);
        agentAuthorized = !!domainAuths && domainAuths.length > 0;
      } else if (hasAdagents === false) {
        status = 'error';
        errors.push('adagents.json present but invalid');
      } else {
        status = 'missing_authorization';
        errors.push('No adagents.json found on domain');
      }
    } else {
      // For direct/delegated/ad_network: check publisher's adagents.json authorizes our agents
      const domainAuths = authorizedDomains.get(domain);
      if (domainAuths && domainAuths.length > 0) {
        status = 'verified';
        agentAuthorized = true;
      } else {
        // Check if domain has adagents.json at all
        const hasAdagents = await federatedIndexDb.hasValidAdagents(domain);
        if (hasAdagents === null) {
          status = 'unreachable';
          errors.push('Domain has no adagents.json');
        } else {
          status = 'missing_authorization';
          errors.push('adagents.json exists but does not authorize any of this org\'s agents');
        }
      }
    }

    propertyDetails.push({
      identifier: prop.identifier,
      type: prop.type,
      relationship: prop.relationship,
      verification_status: status,
      agent_authorized: agentAuthorized,
      errors,
    });
  }

  // Detect orphaned authorizations: domains authorizing our agents but not in brand.json
  const declaredDomains = new Set(
    declared.filter(p => p.type === 'website').map(p => p.identifier.toLowerCase())
  );
  for (const [domain, auths] of authorizedDomains) {
    if (!declaredDomains.has(domain)) {
      propertyDetails.push({
        identifier: domain,
        type: 'website',
        relationship: 'owned', // Placeholder — it's not in brand.json
        verification_status: 'orphaned',
        agent_authorized: true,
        errors: [`Authorized by publisher but not declared in brand.json (via ${auths[0]?.agent_url})`],
      });
    }
  }

  // Check agent health from recent outbound request logs
  const agentHealth: AgentHealth[] = [];
  for (const agentUrl of orgAgentUrls) {
    const recentRequests = await getRequestLog(agentUrl, { limit: 1 });
    const last = recentRequests[0];
    agentHealth.push({
      agent_url: agentUrl,
      agent_id: agentUrl,
      reachable: last?.success ?? false,
      response_time_ms: last?.response_time_ms ?? null,
      error: last?.error_message || undefined,
    });
  }

  // Calculate metrics
  const webProperties = propertyDetails.filter(p => p.type === 'website');
  const verified = webProperties.filter(p => p.verification_status === 'verified').length;
  const missingAuth = webProperties.filter(p => p.verification_status === 'missing_authorization').length;
  const orphaned = webProperties.filter(p => p.verification_status === 'orphaned').length;
  const totalWeb = declared.filter(p => p.type === 'website').length;
  const coveragePct = totalWeb > 0
    ? Math.round((verified / totalWeb) * 100 * 100) / 100
    : 100;

  const report = await networkHealthDb.createReport({
    org_id: orgId,
    brand_domain: brand.brand_domain,
    total_properties: declared.length,
    verified_properties: verified,
    missing_authorization: missingAuth,
    orphaned_authorization: orphaned,
    schema_errors: 0,
    coverage_pct: coveragePct,
    property_details: propertyDetails,
    agent_health: agentHealth,
  });

  // Evaluate and fire alerts
  let alertsFired = 0;
  const alertsToCreate = await networkHealthDb.evaluateAlerts(report);
  if (alertsToCreate.length > 0) {
    const rule = await networkHealthDb.getAlertRule(orgId);
    const notifiedVia = await dispatchNetworkAlerts(orgId, alertsToCreate, rule);

    for (const alert of alertsToCreate) {
      await networkHealthDb.createAlert({ ...alert, notified_via: notifiedVia });
      alertsFired++;
    }
  }

  return { report, alertsFired };
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Generate network consistency reports for all orgs that have brand.json
 * with non-owned properties or registered agents.
 */
export async function generateNetworkConsistencyReports(
  options?: { limit?: number }
): Promise<ReportResult> {
  const limit = options?.limit ?? 50;
  const result: ReportResult = { generated: 0, skipped: 0, failed: 0, alerts_fired: 0 };

  // Find orgs with hosted brands
  const orgsWithBrands = await query<{ workos_organization_id: string }>(
    `SELECT DISTINCT workos_organization_id
     FROM brands
     WHERE workos_organization_id IS NOT NULL
     ORDER BY workos_organization_id
     LIMIT $1`,
    [limit]
  );

  for (const row of orgsWithBrands.rows) {
    const orgId = row.workos_organization_id;

    try {
      // Get org's brands and agent URLs
      const brands = await brandDb.listHostedBrandsByOrg(orgId);
      if (brands.length === 0) {
        result.skipped++;
        continue;
      }

      const profile = await memberDb.getProfileByOrgId(orgId);
      const agentUrls = (profile?.agents ?? [])
        .filter(a => a.visibility === 'public' && a.url)
        .map(a => a.url);

      // Generate report for the primary brand (first one)
      const primaryBrand = brands[0];
      const { alertsFired } = await generateReportForOrg(orgId, primaryBrand, agentUrls);

      result.generated++;
      result.alerts_fired += alertsFired;
    } catch (error) {
      logger.error({ error, orgId }, 'Failed to generate consistency report');
      result.failed++;
    }
  }

  logger.info(result, 'Network consistency reports complete');
  return result;
}
