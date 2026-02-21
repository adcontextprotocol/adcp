/**
 * Persona Inference Service
 *
 * Infers an organization's behavioral persona from available data signals:
 * company_type, revenue_tier, working group memberships, and member insights.
 */

import { getPool } from '../../db/client.js';
import { OrgKnowledgeDatabase, type Persona, type KnowledgeSource } from '../../db/org-knowledge-db.js';
import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'persona-inference' });
const orgKnowledgeDb = new OrgKnowledgeDatabase();

interface InferenceSignals {
  company_type: string | null;
  revenue_tier: string | null;
  working_groups: string[];
  insights: Array<{ attribute: string; value: string }>;
  engagement_score: number | null;
}

interface InferenceResult {
  persona: Persona;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

/**
 * Gather signals for an organization from the database
 */
async function gatherSignals(orgId: string): Promise<InferenceSignals> {
  const pool = getPool();

  const [orgResult, wgResult, knowledgeResult, engagementResult] = await Promise.all([
    pool.query(
      `SELECT company_type, revenue_tier FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    ),
    pool.query(
      `SELECT DISTINCT wg.slug
       FROM working_group_memberships wgm
       JOIN working_groups wg ON wg.id = wgm.working_group_id
       JOIN organization_memberships om ON om.workos_user_id = wgm.workos_user_id
       WHERE om.workos_organization_id = $1 AND wgm.status = 'active'`,
      [orgId]
    ),
    pool.query(
      `SELECT attribute, value FROM org_knowledge
       WHERE workos_organization_id = $1 AND is_current = TRUE
         AND attribute IN ('building', 'company_focus', 'interest', 'aao_goals')`,
      [orgId]
    ),
    pool.query(
      `SELECT engagement_score FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    ),
  ]);

  return {
    company_type: orgResult.rows[0]?.company_type ?? null,
    revenue_tier: orgResult.rows[0]?.revenue_tier ?? null,
    working_groups: wgResult.rows.map(r => r.slug),
    insights: knowledgeResult.rows,
    engagement_score: engagementResult.rows[0]?.engagement_score ?? null,
  };
}

/**
 * Score how well signals match each persona
 */
function scorePersona(signals: InferenceSignals): InferenceResult {
  const scores: Record<Persona, { score: number; reasons: string[] }> = {
    molecule_builder: { score: 0, reasons: [] },
    data_decoder: { score: 0, reasons: [] },
    pureblood_protector: { score: 0, reasons: [] },
    resops_integrator: { score: 0, reasons: [] },
    ladder_climber: { score: 0, reasons: [] },
    simple_starter: { score: 0, reasons: [] },
    pragmatic_builder: { score: 0, reasons: [] },
  };

  // Company type signals
  if (signals.company_type) {
    const ct = signals.company_type.toLowerCase();
    if (['brand', 'agency'].includes(ct)) {
      scores.molecule_builder.score += 2;
      scores.molecule_builder.reasons.push(`company_type: ${ct}`);
      scores.resops_integrator.score += 2;
      scores.resops_integrator.reasons.push(`company_type: ${ct}`);
      scores.pragmatic_builder.score += 1;
      scores.pragmatic_builder.reasons.push(`company_type: ${ct}`);
    }
    if (['publisher'].includes(ct)) {
      scores.molecule_builder.score += 2;
      scores.molecule_builder.reasons.push(`company_type: ${ct}`);
      scores.data_decoder.score += 2;
      scores.data_decoder.reasons.push(`company_type: ${ct}`);
      scores.pureblood_protector.score += 1;
      scores.pureblood_protector.reasons.push(`company_type: ${ct}`);
    }
    if (['data', 'ai', 'adtech'].includes(ct)) {
      scores.data_decoder.score += 3;
      scores.data_decoder.reasons.push(`company_type: ${ct}`);
    }
  }

  // Revenue tier signals
  if (signals.revenue_tier) {
    const rt = signals.revenue_tier;
    if (['under_1m', '1m_5m'].includes(rt)) {
      scores.ladder_climber.score += 3;
      scores.ladder_climber.reasons.push(`revenue_tier: ${rt} (SMB)`);
    }
    if (['5m_25m', '25m_50m'].includes(rt)) {
      scores.pragmatic_builder.score += 2;
      scores.pragmatic_builder.reasons.push(`revenue_tier: ${rt} (mid-market)`);
    }
    if (['50m_250m', '250m_1b', '1b_plus'].includes(rt)) {
      scores.molecule_builder.score += 1;
      scores.molecule_builder.reasons.push(`revenue_tier: ${rt} (enterprise)`);
      scores.resops_integrator.score += 2;
      scores.resops_integrator.reasons.push(`revenue_tier: ${rt} (enterprise)`);
    }
  }

  // Working group signals (match by slug prefix/keyword since actual slugs include suffixes like '-wg', '-council')
  const creativePatterns = ['creative', 'media-buying'];
  const dataPatterns = ['signals-data', 'technical-standards'];
  const experiencePatterns = ['ctv', 'audio', 'retail-media', 'ooh', 'mobile', 'ai-surfaces'];
  const customerPatterns = ['brand-agency', 'creator-economy', 'policy'];

  const matchesAny = (slug: string, patterns: string[]) => patterns.some(p => slug.includes(p));

  for (const wg of signals.working_groups) {
    if (matchesAny(wg, creativePatterns)) {
      scores.molecule_builder.score += 2;
      scores.molecule_builder.reasons.push(`working group: ${wg}`);
    }
    if (matchesAny(wg, dataPatterns)) {
      scores.data_decoder.score += 2;
      scores.data_decoder.reasons.push(`working group: ${wg}`);
    }
    if (matchesAny(wg, experiencePatterns)) {
      scores.pureblood_protector.score += 1;
      scores.pureblood_protector.reasons.push(`working group: ${wg}`);
    }
    if (matchesAny(wg, customerPatterns)) {
      scores.pureblood_protector.score += 2;
      scores.pureblood_protector.reasons.push(`working group: ${wg}`);
    }
  }

  // Insight signals (keyword-based)
  for (const insight of signals.insights) {
    const val = insight.value.toLowerCase();
    if (/creat|content|context|storytell|brand safe/i.test(val)) {
      scores.molecule_builder.score += 1;
      scores.molecule_builder.reasons.push(`insight: "${insight.value.substring(0, 50)}"`);
    }
    if (/data|analyt|measur|attribution|ai|machine learn/i.test(val)) {
      scores.data_decoder.score += 1;
      scores.data_decoder.reasons.push(`insight: "${insight.value.substring(0, 50)}"`);
    }
    if (/privacy|consent|clean|responsib|transparen/i.test(val)) {
      scores.pureblood_protector.score += 1;
      scores.pureblood_protector.reasons.push(`insight: "${insight.value.substring(0, 50)}"`);
    }
    if (/integrat|unified|cross.?channel|full.?stack|ops/i.test(val)) {
      scores.resops_integrator.score += 1;
      scores.resops_integrator.reasons.push(`insight: "${insight.value.substring(0, 50)}"`);
    }
    if (/pragmat|generalist|multi.?channel|experiment|test.?and.?learn|agile|lean|bootstrap/i.test(val)) {
      scores.pragmatic_builder.score += 1;
      scores.pragmatic_builder.reasons.push(`insight: "${insight.value.substring(0, 50)}"`);
    }
  }

  // Breadth of working group membership signals a generalist
  if (signals.working_groups.length >= 3) {
    const categories = new Set<string>();
    for (const wg of signals.working_groups) {
      if (matchesAny(wg, creativePatterns)) categories.add('creative');
      if (matchesAny(wg, dataPatterns)) categories.add('data');
      if (matchesAny(wg, experiencePatterns)) categories.add('experience');
      if (matchesAny(wg, customerPatterns)) categories.add('customer');
    }
    scores.pragmatic_builder.score += 2;
    scores.pragmatic_builder.reasons.push(`broad working group membership: ${signals.working_groups.length} groups`);
    if (categories.size >= 2) {
      scores.pragmatic_builder.score += 1;
      scores.pragmatic_builder.reasons.push(`cross-category engagement: ${[...categories].join(', ')}`);
    }
  }

  // Low engagement -> simple_starter
  if (signals.engagement_score !== null && signals.engagement_score < 20) {
    scores.simple_starter.score += 3;
    scores.simple_starter.reasons.push(`low engagement score: ${signals.engagement_score}`);
  }

  // Find the highest scoring persona
  let bestPersona: Persona = 'simple_starter';
  let bestScore = 0;
  for (const [persona, data] of Object.entries(scores) as [Persona, { score: number; reasons: string[] }][]) {
    if (data.score > bestScore) {
      bestScore = data.score;
      bestPersona = persona;
    }
  }

  // Determine confidence based on score margin
  let confidence: 'high' | 'medium' | 'low' = 'low';
  const sortedScores = Object.values(scores).map(s => s.score).sort((a, b) => b - a);
  const margin = sortedScores[0] - (sortedScores[1] || 0);
  if (bestScore >= 5 && margin >= 3) {
    confidence = 'high';
  } else if (bestScore >= 3 && margin >= 1) {
    confidence = 'medium';
  }

  return {
    persona: bestPersona,
    confidence,
    reasons: scores[bestPersona].reasons,
  };
}

/**
 * Infer and set persona for a single organization.
 * Only writes if no higher-authority source (diagnostic, admin, user) exists.
 */
export async function inferPersonaForOrg(orgId: string): Promise<InferenceResult | null> {
  // Check if org already has a persona from a higher-authority source
  const existing = await orgKnowledgeDb.resolveAttribute(orgId, 'persona');
  if (existing && !existing.is_stale && ['user_reported', 'admin_set', 'diagnostic'].includes(existing.source)) {
    return null; // Don't override higher-authority sources
  }

  const signals = await gatherSignals(orgId);
  const result = scorePersona(signals);

  // Only write if we have at least some signal
  if (result.persona === 'simple_starter' && result.reasons.length === 0) {
    return null; // No data to infer from
  }

  await orgKnowledgeDb.setPersona(orgId, result.persona, 'addie_inferred', {
    source_reference: `inference: ${result.reasons.join('; ')}`,
  });

  logger.info(
    { orgId, persona: result.persona, confidence: result.confidence, reasons: result.reasons },
    'Persona inferred for organization'
  );

  return result;
}

/**
 * Run persona inference as a background job.
 * Processes orgs without a persona or with stale inferences.
 */
export async function runPersonaInferenceJob(options: { limit?: number } = {}): Promise<{
  processed: number;
  inferred: number;
  skipped: number;
}> {
  const { limit = 50 } = options;
  const pool = getPool();

  // Find orgs needing persona inference
  const result = await pool.query(
    `SELECT o.workos_organization_id
     FROM organizations o
     WHERE o.is_personal = false
       AND (
         o.persona IS NULL
         OR (o.persona_source = 'addie_inferred' AND o.persona_set_at < NOW() - INTERVAL '30 days')
       )
     ORDER BY o.last_activity_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );

  let inferred = 0;
  let skipped = 0;

  for (const row of result.rows) {
    try {
      const inferenceResult = await inferPersonaForOrg(row.workos_organization_id);
      if (inferenceResult) {
        inferred++;
      } else {
        skipped++;
      }
    } catch (error) {
      logger.warn({ error, orgId: row.workos_organization_id }, 'Failed to infer persona');
      skipped++;
    }
  }

  return { processed: result.rows.length, inferred, skipped };
}
