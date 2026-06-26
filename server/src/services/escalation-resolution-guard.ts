import type { Pool } from 'pg';
import { getDomain } from 'tldts';
import { getPool } from '../db/client.js';
import type { Escalation, EscalationStatus } from '../db/escalation-db.js';
import { checkAgentHostnameAgainstDomains } from './agent-hostname-verification.js';

export interface EscalationResolutionBlocker {
  type:
    | 'missing_local_domain'
    | 'unverified_local_domain'
    | 'personal_workspace_domain'
    | 'missing_member_profile'
    | 'agent_hostname_not_verified'
    | 'member_null_unchecked';
  domain?: string;
  message: string;
  details?: Record<string, unknown>;
}

export type EscalationResolutionGuardResult =
  | { ok: true; checked: boolean }
  | { ok: false; checked: true; blockers: EscalationResolutionBlocker[] };

interface DomainRow {
  domain: string;
  workos_organization_id: string;
  organization_name: string | null;
  is_personal: boolean | null;
  verified: boolean;
  member_status: string | null;
  subscription_status: string | null;
}

const REGISTRY_SETUP_RE = /\b(registry|member:\s*null|domain verification|verify_brand_domain_challenge|save_agent|brand manifest|adagents|agent registration|pending sync|propagation)\b/i;
const DOMAIN_RE = /\b(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s)>'"]+/gi;
const IGNORED_DOMAINS = new Set([
  'agenticadvertising.org',
  'adcontextprotocol.org',
  'github.com',
  'slack.com',
  'workos.com',
]);

function escalationText(escalation: Escalation): string {
  return [
    escalation.summary,
    escalation.original_request ?? '',
    escalation.addie_context ?? '',
    escalation.resolution_notes ?? '',
  ].join('\n');
}

export function isRegistrySetupEscalation(escalation: Escalation): boolean {
  return REGISTRY_SETUP_RE.test(escalationText(escalation));
}

function toBaseDomain(hostname: string): string | null {
  const withoutProtocol = hostname.replace(/^https?:\/\//i, '');
  const normalized = withoutProtocol
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
  return getDomain(normalized, { allowPrivateDomains: true });
}

export function extractEscalationDomains(escalation: Escalation): string[] {
  const text = escalationText(escalation);
  const domains = new Set<string>();
  for (const match of text.matchAll(DOMAIN_RE)) {
    const raw = match[0];
    if (raw.includes('@')) continue;
    const base = toBaseDomain(raw);
    if (base && !IGNORED_DOMAINS.has(base)) domains.add(base);
  }
  return [...domains].sort();
}

export function extractEscalationAgentUrls(escalation: Escalation): string[] {
  const text = escalationText(escalation);
  const urls = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    try {
      const url = new URL(match[0]);
      const base = toBaseDomain(url.hostname);
      if (!base || IGNORED_DOMAINS.has(base)) continue;
      urls.add(url.toString());
    } catch {
      // Ignore malformed free-text URL fragments.
    }
  }
  return [...urls].sort();
}

export async function guardEscalationResolution(input: {
  escalation: Escalation;
  status: EscalationStatus;
  pool?: Pool;
}): Promise<EscalationResolutionGuardResult> {
  if (input.status !== 'resolved') {
    return { ok: true, checked: false };
  }
  if (!isRegistrySetupEscalation(input.escalation)) {
    return { ok: true, checked: false };
  }

  const domains = extractEscalationDomains(input.escalation);
  const blockers: EscalationResolutionBlocker[] = [];
  if (domains.length === 0) {
    blockers.push({
      type: 'member_null_unchecked',
      message:
        'This looks like a registry/domain propagation escalation, but no domain could be extracted for a local state check. Resolve as wont_do if invalid, or add domain evidence before marking resolved.',
    });
    return { ok: false, checked: true, blockers };
  }

  const pool = input.pool ?? getPool();
  const result = await pool.query<DomainRow>(
    `SELECT
       od.domain,
       od.workos_organization_id,
       o.name AS organization_name,
       o.is_personal,
       od.verified,
       o.member_status,
       o.subscription_status
     FROM organization_domains od
     LEFT JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
     WHERE od.domain = ANY($1::text[])`,
    [domains],
  );
  const rowsByDomain = new Map(result.rows.map((row) => [row.domain.toLowerCase(), row]));
  const orgIdsForAgentCheck = new Set<string>();

  for (const domain of domains) {
    const row = rowsByDomain.get(domain);
    if (!row) {
      blockers.push({
        type: 'missing_local_domain',
        domain,
        message: `Cannot mark resolved: ${domain} has no local organization_domains row.`,
      });
      continue;
    }

    if (!row.verified) {
      blockers.push({
        type: 'unverified_local_domain',
        domain,
        message: `Cannot mark resolved: ${domain} is still unverified locally.`,
        details: {
          workos_organization_id: row.workos_organization_id,
          organization_name: row.organization_name,
        },
      });
    }

    if (row.is_personal) {
      blockers.push({
        type: 'personal_workspace_domain',
        domain,
        message:
          `Cannot mark resolved: ${domain} is attached to personal workspace ` +
          `"${row.organization_name ?? row.workos_organization_id}", not a company org.`,
        details: {
          workos_organization_id: row.workos_organization_id,
          organization_name: row.organization_name,
          member_status: row.member_status,
          subscription_status: row.subscription_status,
        },
      });
    }

    if (row && row.verified && !row.is_personal) {
      orgIdsForAgentCheck.add(row.workos_organization_id);
      const profileResult = await pool.query<{ id: string }>(
        `SELECT mp.id
         FROM member_profiles mp
         WHERE mp.workos_organization_id = $1
         LIMIT 1`,
        [row.workos_organization_id],
      );
      if (profileResult.rows.length === 0) {
        blockers.push({
          type: 'missing_member_profile',
          domain,
          message: `Cannot mark resolved: ${domain} is verified locally but has no member profile, so /api/registry/operator still returns member:null.`,
          details: {
            workos_organization_id: row.workos_organization_id,
            organization_name: row.organization_name,
          },
        });
      }
    }
  }

  const agentUrls = extractEscalationAgentUrls(input.escalation);
  if (agentUrls.length > 0 && orgIdsForAgentCheck.size > 0) {
    const verifiedDomains = await pool.query<{ workos_organization_id: string; domain: string }>(
      `SELECT workos_organization_id, domain
       FROM organization_domains
       WHERE workos_organization_id = ANY($1::text[])
         AND verified = true`,
      [[...orgIdsForAgentCheck]],
    );
    const domainsByOrg = new Map<string, string[]>();
    for (const row of verifiedDomains.rows) {
      const existing = domainsByOrg.get(row.workos_organization_id) ?? [];
      existing.push(row.domain.toLowerCase());
      domainsByOrg.set(row.workos_organization_id, existing);
    }

    for (const agentUrl of agentUrls) {
      let covered = false;
      const failures: unknown[] = [];
      for (const orgId of orgIdsForAgentCheck) {
        const verification = checkAgentHostnameAgainstDomains(agentUrl, domainsByOrg.get(orgId) ?? [], orgId);
        if (verification.ok) {
          covered = true;
          break;
        }
        failures.push({ orgId, verification });
      }
      if (!covered) {
        blockers.push({
          type: 'agent_hostname_not_verified',
          message: `Cannot mark resolved: agent URL ${agentUrl} is not covered by any verified company-domain row referenced in this escalation.`,
          details: {
            agent_url: agentUrl,
            failures,
          },
        });
      }
    }
  }

  if (blockers.length > 0) {
    return { ok: false, checked: true, blockers };
  }
  return { ok: true, checked: true };
}
