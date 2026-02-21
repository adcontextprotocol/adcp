import { query } from './client.js';

// =====================================================
// TYPES
// =====================================================

export type KnowledgeSource = 'user_reported' | 'admin_set' | 'diagnostic' | 'enrichment' | 'addie_inferred';
export type KnowledgeConfidence = 'high' | 'medium' | 'low';

/** Authority rank for sources (lower number = higher authority) */
const SOURCE_AUTHORITY: Record<KnowledgeSource, number> = {
  user_reported: 1,
  admin_set: 2,
  diagnostic: 3,
  enrichment: 4,
  addie_inferred: 5,
};

/** How many days before knowledge from each source is considered stale */
const SOURCE_STALENESS_DAYS: Record<KnowledgeSource, number> = {
  user_reported: 365,
  admin_set: 365,
  diagnostic: 180,
  enrichment: 30,
  addie_inferred: 90,
};

export interface OrgKnowledge {
  id: number;
  workos_organization_id: string;
  attribute: string;
  value: string;
  value_json: unknown | null;
  source: KnowledgeSource;
  confidence: KnowledgeConfidence;
  set_by_user_id: string | null;
  set_by_description: string | null;
  set_at: Date;
  verified_at: Date | null;
  is_current: boolean;
  superseded_by: number | null;
  superseded_at: Date | null;
  source_reference: string | null;
  created_at: Date;
}

export interface SetKnowledgeInput {
  workos_organization_id: string;
  attribute: string;
  value: string;
  value_json?: unknown;
  source: KnowledgeSource;
  confidence?: KnowledgeConfidence;
  set_by_user_id?: string;
  set_by_description?: string;
  source_reference?: string;
}

export interface ResolvedKnowledge {
  attribute: string;
  value: string;
  value_json: unknown | null;
  source: KnowledgeSource;
  confidence: KnowledgeConfidence;
  set_at: Date;
  verified_at: Date | null;
  is_stale: boolean;
}

export type Persona = 'molecule_builder' | 'data_decoder' | 'pureblood_protector' | 'resops_integrator' | 'ladder_climber' | 'simple_starter' | 'pragmatic_builder';

export type JourneyStage = 'aware' | 'evaluating' | 'joined' | 'onboarding' | 'participating' | 'contributing' | 'leading' | 'advocating';

export type JourneyTriggerType = 'milestone_achieved' | 'milestone_lost' | 'admin_override' | 'recomputation' | 'initial' | 'membership_change' | 'leadership_change' | 'content_contribution';

export interface JourneyStageTransition {
  id: number;
  workos_organization_id: string;
  from_stage: JourneyStage | null;
  to_stage: JourneyStage;
  trigger_type: JourneyTriggerType;
  trigger_detail: string | null;
  triggered_by: string | null;
  transitioned_at: Date;
}

// =====================================================
// DATABASE CLASS
// =====================================================

export class OrgKnowledgeDatabase {

  // ============== Knowledge CRUD ==============

  /**
   * Set a knowledge entry for an org. Supersedes any existing current entry
   * from the same source for the same attribute.
   */
  async setKnowledge(input: SetKnowledgeInput): Promise<OrgKnowledge> {
    // Insert the new entry first
    const result = await query<OrgKnowledge>(
      `INSERT INTO org_knowledge (
        workos_organization_id, attribute, value, value_json,
        source, confidence, set_by_user_id, set_by_description,
        source_reference
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        input.workos_organization_id,
        input.attribute,
        input.value,
        input.value_json ?? null,
        input.source,
        input.confidence ?? 'medium',
        input.set_by_user_id ?? null,
        input.set_by_description ?? null,
        input.source_reference ?? null,
      ]
    );

    const newEntry = result.rows[0];

    // Supersede existing current entries from the same source, pointing to the new entry
    await query(
      `UPDATE org_knowledge
       SET is_current = FALSE,
           superseded_at = NOW(),
           superseded_by = $4
       WHERE workos_organization_id = $1
         AND attribute = $2
         AND source = $3
         AND is_current = TRUE
         AND id != $4`,
      [input.workos_organization_id, input.attribute, input.source, newEntry.id]
    );

    return newEntry;
  }

  /**
   * Get all current knowledge entries for an org.
   */
  async getKnowledgeForOrg(orgId: string): Promise<OrgKnowledge[]> {
    const result = await query<OrgKnowledge>(
      `SELECT * FROM org_knowledge
       WHERE workos_organization_id = $1 AND is_current = TRUE
       ORDER BY attribute, set_at DESC`,
      [orgId]
    );
    return result.rows;
  }

  /**
   * Get all current entries for a specific attribute across all sources.
   */
  async getKnowledgeEntries(orgId: string, attribute: string): Promise<OrgKnowledge[]> {
    const result = await query<OrgKnowledge>(
      `SELECT * FROM org_knowledge
       WHERE workos_organization_id = $1
         AND attribute = $2
         AND is_current = TRUE
       ORDER BY set_at DESC`,
      [orgId, attribute]
    );
    return result.rows;
  }

  /**
   * Get the full history of an attribute for an org (including superseded entries).
   */
  async getKnowledgeHistory(orgId: string, attribute: string): Promise<OrgKnowledge[]> {
    const result = await query<OrgKnowledge>(
      `SELECT * FROM org_knowledge
       WHERE workos_organization_id = $1 AND attribute = $2
       ORDER BY set_at DESC`,
      [orgId, attribute]
    );
    return result.rows;
  }

  /**
   * Mark a knowledge entry as verified (confirmed still accurate).
   */
  async verifyKnowledge(id: number): Promise<void> {
    await query(
      `UPDATE org_knowledge SET verified_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  // ============== Precedence Resolution ==============

  /**
   * Resolve the authoritative value for an attribute.
   *
   * Precedence logic:
   * 1. Source authority rank (user_reported > admin_set > diagnostic > enrichment > addie_inferred)
   * 2. Within the same authority tier, prefer more recent entries
   * 3. Stale entries (older than source-specific threshold) are deprioritized
   *
   * Returns null if no current knowledge exists for this attribute.
   */
  async resolveAttribute(orgId: string, attribute: string): Promise<ResolvedKnowledge | null> {
    const entries = await this.getKnowledgeEntries(orgId, attribute);
    if (entries.length === 0) return null;

    return this.pickAuthoritative(entries);
  }

  /**
   * Resolve all attributes for an org at once.
   * Returns a map of attribute -> resolved value.
   */
  async resolveAllAttributes(orgId: string): Promise<Map<string, ResolvedKnowledge>> {
    const allKnowledge = await this.getKnowledgeForOrg(orgId);

    // Group by attribute
    const grouped = new Map<string, OrgKnowledge[]>();
    for (const entry of allKnowledge) {
      const existing = grouped.get(entry.attribute) ?? [];
      existing.push(entry);
      grouped.set(entry.attribute, existing);
    }

    // Resolve each attribute
    const resolved = new Map<string, ResolvedKnowledge>();
    for (const [attribute, entries] of grouped) {
      const winner = this.pickAuthoritative(entries);
      if (winner) {
        resolved.set(attribute, winner);
      }
    }

    return resolved;
  }

  /**
   * Pick the most authoritative entry from a list of current entries
   * for the same attribute.
   */
  private pickAuthoritative(entries: OrgKnowledge[]): ResolvedKnowledge | null {
    if (entries.length === 0) return null;

    const now = Date.now();

    // Score each entry
    const scored = entries.map(entry => {
      const authorityRank = SOURCE_AUTHORITY[entry.source] ?? 5;
      const stalenessDays = SOURCE_STALENESS_DAYS[entry.source] ?? 90;
      const verifiedAt = entry.verified_at ?? entry.set_at;
      const daysSinceVerified = (now - new Date(verifiedAt).getTime()) / (1000 * 60 * 60 * 24);
      const isStale = daysSinceVerified > stalenessDays;

      // Score: lower is better
      // Non-stale entries get a major bonus (subtract 100 from their score)
      // Then sort by authority rank, then by recency
      const stalenessBonus = isStale ? 0 : -100;
      const recencyScore = daysSinceVerified / 365; // 0-1 scale per year
      const score = stalenessBonus + (authorityRank * 10) + recencyScore;

      return { entry, score, isStale };
    });

    // Sort by score ascending (lower = better)
    scored.sort((a, b) => a.score - b.score);

    const best = scored[0];
    return {
      attribute: best.entry.attribute,
      value: best.entry.value,
      value_json: best.entry.value_json,
      source: best.entry.source,
      confidence: best.entry.confidence,
      set_at: best.entry.set_at,
      verified_at: best.entry.verified_at,
      is_stale: best.isStale,
    };
  }

  // ============== Persona ==============

  /**
   * Set the persona for an org. Updates both org_knowledge and the
   * materialized column on organizations.
   */
  async setPersona(
    orgId: string,
    persona: Persona,
    source: KnowledgeSource,
    options?: {
      aspiration_persona?: Persona;
      set_by_user_id?: string;
      source_reference?: string;
    }
  ): Promise<void> {
    // Record in org_knowledge
    await this.setKnowledge({
      workos_organization_id: orgId,
      attribute: 'persona',
      value: persona,
      source,
      confidence: source === 'diagnostic' || source === 'user_reported' ? 'high' : 'medium',
      set_by_user_id: options?.set_by_user_id,
      set_by_description: `persona set via ${source}`,
      source_reference: options?.source_reference,
    });

    // Materialize on organizations table
    await query(
      `UPDATE organizations SET
        persona = $2,
        persona_source = $3,
        persona_set_at = NOW(),
        aspiration_persona = COALESCE($4, aspiration_persona),
        updated_at = NOW()
       WHERE workos_organization_id = $1`,
      [orgId, persona, source, options?.aspiration_persona ?? null]
    );

    // Record aspiration if provided
    if (options?.aspiration_persona) {
      await this.setKnowledge({
        workos_organization_id: orgId,
        attribute: 'aspiration_persona',
        value: options.aspiration_persona,
        source,
        confidence: source === 'diagnostic' || source === 'user_reported' ? 'high' : 'medium',
        set_by_user_id: options.set_by_user_id,
        source_reference: options.source_reference,
      });
    }
  }

  // ============== Journey Stage ==============

  /**
   * Transition an org to a new journey stage. Records the transition
   * in history and updates the materialized column.
   */
  async transitionJourneyStage(
    orgId: string,
    toStage: JourneyStage,
    triggerType: JourneyTriggerType,
    options?: {
      trigger_detail?: string;
      triggered_by?: string;
    }
  ): Promise<JourneyStageTransition | null> {
    // Get current stage
    const currentResult = await query<{ journey_stage: JourneyStage | null }>(
      `SELECT journey_stage FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    );
    if (currentResult.rows.length === 0) return null;

    const fromStage = currentResult.rows[0].journey_stage ?? null;

    // Skip if already at this stage
    if (fromStage === toStage) return null;

    // Record transition
    const transitionResult = await query<JourneyStageTransition>(
      `INSERT INTO journey_stage_history (
        workos_organization_id, from_stage, to_stage,
        trigger_type, trigger_detail, triggered_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        orgId,
        fromStage,
        toStage,
        triggerType,
        options?.trigger_detail ?? null,
        options?.triggered_by ?? 'system',
      ]
    );

    // Update materialized column
    await query(
      `UPDATE organizations SET
        journey_stage = $2,
        journey_stage_set_at = NOW(),
        updated_at = NOW()
       WHERE workos_organization_id = $1`,
      [orgId, toStage]
    );

    // Record in org_knowledge
    await this.setKnowledge({
      workos_organization_id: orgId,
      attribute: 'journey_stage',
      value: toStage,
      source: triggerType === 'admin_override' ? 'admin_set' : 'addie_inferred',
      confidence: triggerType === 'admin_override' ? 'high' : 'medium',
      set_by_description: `journey transition: ${triggerType}`,
      source_reference: options?.trigger_detail,
    });

    return transitionResult.rows[0];
  }

  /**
   * Get journey stage history for an org.
   */
  async getJourneyHistory(orgId: string): Promise<JourneyStageTransition[]> {
    const result = await query<JourneyStageTransition>(
      `SELECT * FROM journey_stage_history
       WHERE workos_organization_id = $1
       ORDER BY transitioned_at DESC`,
      [orgId]
    );
    return result.rows;
  }

  // ============== Persona-Group Affinity ==============

  /**
   * Get recommended working groups/councils for a persona.
   */
  async getGroupsForPersona(persona: Persona): Promise<Array<{
    working_group_id: string;
    name: string;
    committee_type: string;
    affinity_score: number;
  }>> {
    const result = await query<{
      working_group_id: string;
      name: string;
      committee_type: string;
      affinity_score: number;
    }>(
      `SELECT pga.working_group_id, wg.name, wg.committee_type, pga.affinity_score
       FROM persona_group_affinity pga
       JOIN working_groups wg ON wg.id = pga.working_group_id
       WHERE pga.persona = $1
       ORDER BY pga.affinity_score DESC, wg.name`,
      [persona]
    );
    return result.rows;
  }

  // ============== Staleness Detection ==============

  /**
   * Find orgs with stale knowledge that should be re-verified or refreshed.
   */
  async findStaleKnowledge(limit = 100): Promise<Array<{
    workos_organization_id: string;
    org_name: string;
    attribute: string;
    value: string;
    source: KnowledgeSource;
    days_since_verified: number;
  }>> {
    const result = await query<{
      workos_organization_id: string;
      org_name: string;
      attribute: string;
      value: string;
      source: KnowledgeSource;
      days_since_verified: number;
    }>(
      `SELECT
        ok.workos_organization_id,
        o.name as org_name,
        ok.attribute,
        ok.value,
        ok.source,
        EXTRACT(DAY FROM NOW() - COALESCE(ok.verified_at, ok.set_at))::INTEGER as days_since_verified
       FROM org_knowledge ok
       JOIN organizations o ON o.workos_organization_id = ok.workos_organization_id
       WHERE ok.is_current = TRUE
         AND EXTRACT(DAY FROM NOW() - COALESCE(ok.verified_at, ok.set_at)) > CASE ok.source
           WHEN 'enrichment' THEN 30
           WHEN 'addie_inferred' THEN 90
           WHEN 'diagnostic' THEN 180
           ELSE 365
         END
       ORDER BY days_since_verified DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}
