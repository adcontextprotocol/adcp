/**
 * Prospect triage service
 *
 * Automatically assesses email domains to determine whether to create a prospect
 * and who should own it. Used by reactive triggers (Slack join, website signup)
 * and the scheduled triage job.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import { isFreeEmailDomain } from '../utils/email-domain.js';
import { enrichDomain } from './enrichment.js';
import { isLushaConfigured } from './lusha.js';
import { createProspect } from './prospect.js';
import { notifyNewProspect } from '../notifications/prospect.js';
import { ModelConfig } from '../config/models.js';
import { COMPANY_TYPE_VALUES, getCompanyTypesDocumentation } from '../config/company-types.js';
import { getSetting, SETTING_KEYS } from '../db/system-settings-db.js';

const logger = createLogger('prospect-triage');

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TriageResult {
  action: 'skip' | 'create';
  /** Short reason code for logging */
  reason: string;
  owner: 'addie' | 'human';
  /** High-value mid-market vs standard — informs outreach tone */
  priority: 'high' | 'standard';
  /** Plain-language two-sentence assessment */
  verdict: string;
  companyName?: string;
  companyType?: string;
  /** Set when the domain is already tracked */
  existingOrgId?: string;
}

export interface TriageContext {
  name?: string;
  email?: string;
  title?: string;
  source?: string;
}

// ─── Claude triage prompt ──────────────────────────────────────────────────

const TRIAGE_SYSTEM_PROMPT = `You are an SDR assistant for AgenticAdvertising.org, a membership organization for the ad tech and AI advertising industry.

Your job is to assess email domains to determine if the associated company should be added as a prospect.

AgenticAdvertising.org members include companies in these categories:
${getCompanyTypesDocumentation()}

**Respond with JSON only. No markdown, no explanation.**

Response schema:
{
  "action": "skip" | "create",
  "reason": "brief reason for your decision (one sentence)",
  "owner": "addie" | "human",
  "priority": "high" | "standard",
  "verdict": "two-sentence summary of who this company is and why they are or aren't a good fit",
  "company_name": "your best guess at the company name based on the domain or enrichment data",
  "company_type": "adtech" | "agency" | "brand" | "publisher" | "data" | "ai" | "other" | null
}

**action: "skip"** when:
- The company is clearly not in the ad tech / digital media ecosystem
- The domain appears to belong to an individual consultant with no clear company
- Government entity, school, or hospital with no advertising relevance
- You cannot identify any connection to advertising, media, or AI

**action: "create"** when:
- The company is an advertiser, agency, media company, publisher, ad tech vendor, data company, or AI company
- The company participates in the digital advertising ecosystem in any meaningful way
- When in doubt about relevance, prefer "create" over "skip"

**owner: "addie"** for:
- Startups, scale-ups, mid-market companies
- Companies with < 1000 employees or < $100M revenue
- Smaller brands, regional agencies, independent publishers

**owner: "addie", priority: "high"** for:
- Revenue $100M-$1B or employee count 1,000-5,000
- Well-known ad tech companies (DoubleVerify, IAS, LiveRamp, Magnite, PubMatic, etc.)
- Named mid-market agencies or agency networks

**owner: "addie", priority: "standard"** for:
- Everyone else that qualifies for create

**owner: "human"** for:
- Major enterprises (Fortune 500 brands, major holding companies like WPP/IPG/Publicis/Omnicom/Dentsu/Havas/Stagwell)
- Major publishers (NYT, Condé Nast, NBCUniversal, Disney, Warner Bros Discovery, etc.)
- Prominent platforms (Google, Meta, Amazon, The Trade Desk, Microsoft, etc.)
- Enrichment shows revenue > $1B or employee count > 5000

**Industry context:**
Ad tech companies often have non-obvious names. Look for these signals:
- Domain keywords: ad, ads, media, programmatic, dsp, ssp, data, signal, pixel, attribution, identity, verify, measure, target, audience, creative, exchange
- Enrichment industries: Advertising, Marketing, Media, Information Technology (when description relates to advertising)
- Contact titles containing: media, ad, programmatic, audience, campaign, publisher, exchange, DSP, SSP
- Company descriptions mentioning advertising, media buying, audience data, ad serving, or programmatic`;

interface ClaudeTriageResponse {
  action: 'skip' | 'create';
  reason: string;
  owner: 'addie' | 'human';
  priority?: 'high' | 'standard';
  verdict: string;
  company_name?: string;
  company_type?: string | null;
}

// ─── Kill switch ───────────────────────────────────────────────────────────

async function isTriageEnabled(): Promise<boolean> {
  const setting = await getSetting<{ enabled: boolean }>(SETTING_KEYS.PROSPECT_TRIAGE_ENABLED);
  // Default to enabled if not set
  return setting?.enabled ?? true;
}

// ─── Feedback loop: recent disqualifications ───────────────────────────────

async function getRecentDisqualifications(): Promise<string> {
  const pool = getPool();
  const result = await pool.query<{ email_domain: string; disqualification_reason: string | null; company_type: string | null }>(
    `SELECT email_domain, disqualification_reason, company_type
     FROM organizations
     WHERE prospect_status = 'disqualified'
       AND disqualification_reason IS NOT NULL
       AND updated_at > NOW() - INTERVAL '90 days'
     ORDER BY updated_at DESC
     LIMIT 10`
  );

  if (result.rows.length === 0) return '';

  const lines = result.rows.map(r => {
    const parts = [r.email_domain];
    if (r.company_type) parts.push(`(${r.company_type})`);
    parts.push(`— ${r.disqualification_reason}`);
    return `- ${parts.join(' ')}`;
  });

  return `\nRecently disqualified companies (learn from these — avoid creating similar prospects):\n${lines.join('\n')}`;
}

// ─── Triage log ────────────────────────────────────────────────────────────

async function logTriageDecision(
  domain: string,
  result: TriageResult,
  source: string | undefined,
  enriched: boolean
): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO prospect_triage_log (domain, action, reason, owner, priority, verdict, company_name, company_type, source, enriched)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        domain,
        result.action,
        result.reason,
        result.owner,
        result.priority,
        result.verdict,
        result.companyName ?? null,
        result.companyType ?? null,
        source ?? null,
        enriched,
      ]
    );
  } catch (err) {
    // Don't fail triage if logging fails
    logger.warn({ err, domain }, 'Failed to log triage decision');
  }
}

// ─── Claude assessment ─────────────────────────────────────────────────────

async function assessWithClaude(
  domain: string,
  enrichmentContext: string
): Promise<ClaudeTriageResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      action: 'create',
      reason: 'claude_not_configured',
      owner: 'human',
      priority: 'standard',
      verdict: `New domain ${domain} added for human review.`,
      company_name: domain,
    };
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: ModelConfig.fast,
    max_tokens: 512,
    system: TRIAGE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Assess this email domain as a potential prospect:\n\nDomain: ${domain}\n\n${enrichmentContext}`,
    }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  // Strip markdown code fences if present
  const text = textBlock.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1] : text;

  let parsed: ClaudeTriageResponse;
  try {
    parsed = JSON.parse(jsonStr) as ClaudeTriageResponse;
  } catch (parseErr) {
    throw new Error(`Claude returned malformed JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw: ${jsonStr.slice(0, 200)}`);
  }

  // Ensure company_type is a known value
  if (parsed.company_type && !COMPANY_TYPE_VALUES.includes(parsed.company_type as (typeof COMPANY_TYPE_VALUES)[number])) {
    parsed.company_type = null;
  }

  // Default priority if not returned
  if (!parsed.priority || !['high', 'standard'].includes(parsed.priority)) {
    parsed.priority = 'standard';
  }

  return parsed;
}

// ─── Core assessment (no side effects) ────────────────────────────────────

/**
 * Assess an email domain and return a triage verdict.
 * Does not create any records or send notifications.
 */
export async function triageEmailDomain(
  domain: string,
  context?: TriageContext
): Promise<TriageResult> {
  const normalizedDomain = domain.toLowerCase().trim();

  // 1. Skip free/personal email domains immediately
  if (isFreeEmailDomain(normalizedDomain)) {
    return { action: 'skip', reason: 'personal_email', owner: 'addie', priority: 'standard', verdict: 'Free email provider, not a business domain.' };
  }

  // 2. Skip if already tracked (member or prospect)
  const pool = getPool();
  const existing = await pool.query<{ workos_organization_id: string }>(
    `SELECT o.workos_organization_id
     FROM organizations o
     WHERE o.email_domain = $1
        OR o.workos_organization_id IN (
          SELECT workos_organization_id FROM organization_domains WHERE domain = $1
        )
     LIMIT 1`,
    [normalizedDomain]
  );

  if (existing.rows.length > 0) {
    return {
      action: 'skip',
      reason: 'already_tracked',
      owner: 'addie',
      priority: 'standard',
      verdict: 'Already tracked.',
      existingOrgId: existing.rows[0].workos_organization_id,
    };
  }

  // 3. Enrich via Lusha (best-effort — don't fail triage if unavailable)
  let enrichmentContext = 'No enrichment data available.';
  let enrichedCompanyName: string | undefined;
  let enrichedCompanyType: string | undefined;
  let wasEnriched = false;

  if (isLushaConfigured()) {
    try {
      const enrichResult = await enrichDomain(normalizedDomain);
      if (enrichResult.success && enrichResult.data) {
        const d = enrichResult.data;
        enrichedCompanyName = d.companyName ?? undefined;
        enrichedCompanyType = d.suggestedCompanyType ?? undefined;
        wasEnriched = true;

        const parts: string[] = [];
        if (d.companyName) parts.push(`Company name: ${d.companyName}`);
        if (d.industry) parts.push(`Industry: ${d.industry}`);
        if (d.employeeCount) parts.push(`Employees: ${d.employeeCount}`);
        if (d.revenueRange) parts.push(`Revenue: ${d.revenueRange}`);
        if (d.description) parts.push(`Description: ${d.description}`);
        if (d.specialties?.length) parts.push(`Specialties: ${d.specialties.join(', ')}`);
        if (d.country) parts.push(`Country: ${d.country}`);
        if (d.foundedYear) parts.push(`Founded: ${d.foundedYear}`);
        if (parts.length > 0) enrichmentContext = parts.join('\n');
      }
    } catch (err) {
      logger.warn({ err, domain: normalizedDomain }, 'Enrichment failed during triage, continuing without it');
    }
  }

  // Add caller-provided context
  const contextLines: string[] = [];
  if (context?.name) contextLines.push(`Contact name: ${context.name}`);
  if (context?.title) contextLines.push(`Contact title: ${context.title}`);
  contextLines.push(enrichmentContext);

  // 4. Feedback loop — include recent disqualifications as negative examples
  const disqualificationContext = await getRecentDisqualifications().catch(() => '');
  if (disqualificationContext) {
    contextLines.push(disqualificationContext);
  }

  // 5. Claude assessment
  const assessment = await assessWithClaude(normalizedDomain, contextLines.join('\n'));

  const result: TriageResult = {
    action: assessment.action,
    reason: assessment.reason,
    owner: assessment.owner,
    priority: assessment.priority ?? 'standard',
    verdict: assessment.verdict,
    companyName: enrichedCompanyName ?? assessment.company_name ?? normalizedDomain,
    companyType: enrichedCompanyType ?? assessment.company_type ?? undefined,
  };

  // 6. Log the decision (including skips)
  logTriageDecision(normalizedDomain, result, context?.source, wasEnriched).catch(() => {});

  return result;
}

// ─── Create prospect + notify ──────────────────────────────────────────────

/**
 * Triage a domain and, if warranted, create a prospect record and send a notification.
 * Checks the kill switch before proceeding.
 */
export async function triageAndCreateProspect(
  domain: string,
  context?: TriageContext
): Promise<{ triaged: boolean; created: boolean; orgId?: string; result: TriageResult }> {
  // Check kill switch
  const enabled = await isTriageEnabled();
  if (!enabled) {
    logger.debug({ domain }, 'Prospect triage disabled via system setting');
    return {
      triaged: false,
      created: false,
      result: { action: 'skip', reason: 'triage_disabled', owner: 'addie', priority: 'standard', verdict: 'Automatic triage is disabled.' },
    };
  }

  let result: TriageResult;

  try {
    result = await triageEmailDomain(domain, context);
  } catch (err) {
    logger.error({ err, domain }, 'Triage assessment failed');
    return {
      triaged: false,
      created: false,
      result: { action: 'skip', reason: 'assessment_error', owner: 'human', priority: 'standard', verdict: '' },
    };
  }

  if (result.action === 'skip') {
    logger.debug({ domain, reason: result.reason }, 'Triage: skip');
    return { triaged: true, created: false, orgId: result.existingOrgId, result };
  }

  logger.info({ domain, owner: result.owner, priority: result.priority, companyName: result.companyName }, 'Triage: creating prospect');

  const prospectResult = await createProspect({
    name: result.companyName ?? domain,
    domain,
    company_type: result.companyType,
    prospect_status: 'prospect',
    prospect_source: context?.source ?? 'inbound',
    prospect_notes: result.verdict,
    prospect_owner: result.owner === 'addie' ? 'addie' : undefined,
  });

  if (!prospectResult.success) {
    if (prospectResult.alreadyExists) {
      logger.debug({ domain }, 'Triage: prospect already exists');
      return { triaged: true, created: false, orgId: prospectResult.organization?.workos_organization_id, result };
    }
    logger.error({ domain, error: prospectResult.error }, 'Triage: failed to create prospect');
    return { triaged: true, created: false, result };
  }

  const orgId = prospectResult.organization?.workos_organization_id;

  // Log an activity so humans can see what Addie did
  if (orgId) {
    const pool = getPool();
    pool.query(
      `INSERT INTO org_activities (organization_id, activity_type, description, logged_by_name, activity_date)
       VALUES ($1, 'note', $2, 'Addie', NOW())`,
      [orgId, `Auto-triaged from ${context?.source ?? 'inbound'}: ${result.verdict}`]
    ).catch(err => {
      logger.warn({ err, orgId }, 'Failed to log triage activity');
    });
  }

  // Notify (non-blocking — a missing channel config is fine)
  notifyNewProspect({
    orgName: result.companyName ?? domain,
    domain,
    owner: result.owner,
    priority: result.priority,
    verdict: result.verdict,
    companyType: result.companyType,
    source: context?.source ?? 'inbound',
    orgId,
  }).catch(err => {
    logger.warn({ err, domain }, 'Prospect notification failed');
  });

  return { triaged: true, created: true, orgId, result };
}

// ─── Scheduled batch triage ────────────────────────────────────────────────

/**
 * Find unmapped Slack user email domains not yet in our org table and triage them.
 * Called by the scheduled prospect-triage job.
 */
export async function processUntriagedDomains(opts: { limit: number }): Promise<{
  processed: number;
  created: number;
  skipped: number;
}> {
  // Check kill switch
  const enabled = await isTriageEnabled();
  if (!enabled) {
    logger.info('Prospect triage disabled via system setting, skipping batch');
    return { processed: 0, created: 0, skipped: 0 };
  }

  const pool = getPool();

  // Unmapped Slack users whose domain isn't in any org or org_domains record
  // Also exclude domains we've already triaged (to avoid redundant API calls)
  const domainsResult = await pool.query<{ domain: string }>(
    `SELECT DISTINCT split_part(slack_email, '@', 2) AS domain
     FROM slack_user_mappings
     WHERE status = 'unmapped'
       AND slack_email IS NOT NULL
       AND slack_is_bot = false
       AND slack_is_deleted = false
       AND split_part(slack_email, '@', 2) NOT IN (
         SELECT email_domain FROM organizations WHERE email_domain IS NOT NULL
         UNION
         SELECT domain FROM organization_domains
       )
       AND split_part(slack_email, '@', 2) NOT IN (
         SELECT domain FROM prospect_triage_log WHERE created_at > NOW() - INTERVAL '7 days'
       )
     LIMIT $1`,
    [opts.limit]
  );

  // Additional in-process filter for personal email domains
  const domains = domainsResult.rows
    .map(r => r.domain)
    .filter(d => d && !isFreeEmailDomain(d));

  logger.info({ count: domains.length }, 'Prospect triage: processing unmapped domains');

  let created = 0;
  let skipped = 0;

  for (const domain of domains) {
    try {
      const outcome = await triageAndCreateProspect(domain, { source: 'slack' });
      if (outcome.created) {
        created++;
      } else {
        skipped++;
      }
      // Brief pause to respect API rate limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      logger.error({ err, domain }, 'Triage failed for domain');
      skipped++;
    }
  }

  return { processed: domains.length, created, skipped };
}

// ─── Escalation: auto-claim stale "needs human" prospects ──────────────────

/**
 * Find prospects that were flagged for human review but unclaimed after 48h.
 * Auto-assign to Addie as a fallback so they don't sit idle.
 */
export async function escalateUnclaimedProspects(): Promise<{ escalated: number }> {
  const pool = getPool();

  const result = await pool.query<{ workos_organization_id: string; name: string }>(
    `WITH to_escalate AS (
       SELECT workos_organization_id
       FROM organizations
       WHERE prospect_owner IS NULL
         AND subscription_status IS NULL
         AND COALESCE(prospect_status, 'prospect') = 'prospect'
         AND created_at < NOW() - INTERVAL '48 hours'
         AND created_at > NOW() - INTERVAL '30 days'
       LIMIT 50
     )
     UPDATE organizations o
     SET prospect_owner = 'addie',
         updated_at = NOW()
     FROM to_escalate te
     WHERE o.workos_organization_id = te.workos_organization_id
     RETURNING o.workos_organization_id, o.name`
  );

  for (const row of result.rows) {
    // Log the escalation
    pool.query(
      `INSERT INTO org_activities (organization_id, activity_type, description, logged_by_name, activity_date)
       VALUES ($1, 'note', 'Auto-assigned to Addie after 48h unclaimed', 'System', NOW())`,
      [row.workos_organization_id]
    ).catch(err => {
      logger.warn({ err, orgId: row.workos_organization_id }, 'Failed to log escalation activity');
    });
  }

  if (result.rows.length > 0) {
    logger.info({ count: result.rows.length }, 'Escalated unclaimed prospects to Addie');
  }

  return { escalated: result.rows.length };
}
