/**
 * Registry of protocol-triggered recertification deltas.
 *
 * A "delta" is a targeted re-assessment that lets an existing credential holder
 * stay current with a protocol change by demonstrating only the new criteria,
 * instead of retaking the full module. The recertification engine
 * (`certification/s2-canonical-formats-delta.ts`) is definition-driven: it
 * computes status, windows, and learner-facing copy from a `DeltaDefinition`.
 *
 * Each module that needs a delta registers one entry here. The reason strings
 * a delta surfaces are phrased per-definition via `reason_phrases` so the
 * engine stays module-agnostic while every module reads naturally.
 */

import { SETTING_KEYS } from '../db/system-settings-db.js';

/**
 * Per-definition reason fragments. The engine assembles full reason strings by
 * interpolating these into shared templates. Each module phrases these for its
 * own protocol change so the engine never hard-codes module-specific wording.
 */
export interface DeltaReasonPhrases {
  /**
   * Spelled-out count of delta criteria as it reads in prose, e.g. "five".
   * Used in "Blocked until the {criteria_count_word} ... criteria are present".
   */
  criteria_count_word: string;
  /**
   * Noun phrase naming the criteria, e.g. "AdCP 3.1 S2 canonical-format".
   * Used in "Blocked until the {criteria_count_word} {criteria_phrase} criteria
   * are present in certification_modules.exercise_definitions."
   */
  criteria_phrase: string;
  /**
   * Short noun phrase naming the criteria for the "later of GA and deployment"
   * gate, e.g. "S2 canonical-format". Used in "production deployment of the
   * {criteria_short_phrase} criteria."
   */
  criteria_short_phrase: string;
  /** GA milestone label, e.g. "AdCP 3.1.0 GA". */
  ga_milestone_label: string;
  /** Display name of the GA date for the gated-config message, e.g. "AdCP 3.1.0 GA date". */
  ga_date_label: string;
  /**
   * Label for the credential/module record whose absence fails the
   * auditable-record requirement, e.g. "S2". Used in "Prior {module_label}
   * completion record is missing" and "Prior {module_label} checkpoint trail
   * is missing".
   */
  module_label: string;
  /** Name of the delta, e.g. "S2 canonical-formats". Used in "The {delta_name} delta window has closed.". */
  delta_name: string;
  /** Reason shown when the holder's completion is already on/after the effective point. */
  completion_after_effective: string;
  /** Reason shown when the credential was awarded after the effective point. */
  credential_after_effective: string;
  /** Reason shown when the delta is completed (all criteria evidenced). */
  delta_completed: string;
  /** Reason shown when the holder does not hold the credential. */
  not_credentialed: string;
  /** Reason shown when the holder is eligible for the delta during the window. */
  delta_available: string;
}

export interface DeltaDefinition {
  update_id: string;
  module_id: string;
  credential_id: string;
  criterion_ids: readonly string[];
  /** system_settings key holding the `{ adcp_3_1_ga_at, criteria_deployed_at }` release gate. */
  release_setting_key: string;
  /** Calendar days the delta window stays open after the criteria effective point. */
  delta_window_days: number;
  /** Human label for the delta (e.g. surfaced as the "Protocol updates" heading copy). */
  label: string;
  /**
   * Name of the delta as it reads inside a sentence, e.g. "S2 canonical formats"
   * in "complete the {delta_action_label} delta by ...". Distinct from `label`,
   * which is the bold heading copy.
   */
  delta_action_label: string;
  /**
   * Holder descriptor for the start-of-delta brief, e.g. "S2 Creative" in
   * "an existing {specialist_label} specialist holder".
   */
  specialist_label: string;
  /** Migration filename that deploys the criteria, named in the gated-config reason. */
  criteria_migration: string;
  /** Per-definition reason fragments interpolated into the engine's shared templates. */
  reason_phrases: DeltaReasonPhrases;
}

export const S2_DELTA_DEFINITION: DeltaDefinition = {
  update_id: 's2_canonical_formats_3_1',
  module_id: 'S2',
  credential_id: 'specialist_creative',
  criterion_ids: [
    's2_ex1_sc_format_kind_selection',
    's2_ex1_sc_format_options_cardinality',
    's2_ex1_sc_option_vs_capability_id',
    's2_ex1_sc_source_taxonomy',
    's2_ex1_sc_validation_order',
  ],
  release_setting_key: SETTING_KEYS.CERTIFICATION_S2_CANONICAL_FORMATS_DELTA_RELEASE,
  delta_window_days: 90,
  label: 'S2 Creative canonical formats',
  delta_action_label: 'S2 canonical formats',
  specialist_label: 'S2 Creative',
  criteria_migration: '496_curriculum_3_1_canonical_formats_criteria.sql',
  reason_phrases: {
    criteria_count_word: 'five',
    criteria_phrase: 'AdCP 3.1 S2 canonical-format',
    criteria_short_phrase: 'S2 canonical-format',
    ga_milestone_label: 'AdCP 3.1.0 GA',
    ga_date_label: 'AdCP 3.1.0 GA date',
    module_label: 'S2',
    delta_name: 'S2 canonical-formats',
    completion_after_effective:
      'S2 completion is already on or after the AdCP 3.1 canonical-format criteria effective point.',
    credential_after_effective:
      'S2 credential was awarded after the AdCP 3.1 canonical-format criteria effective point.',
    delta_completed:
      'Learner has auditable evidence for all AdCP 3.1 S2 canonical-format criteria.',
    not_credentialed: 'Learner does not hold the S2 Creative specialist credential.',
    delta_available:
      'Pre-3.1 S2 holder is eligible for the canonical-formats delta assessment.',
  },
};

export const DELTA_DEFINITIONS: DeltaDefinition[] = [S2_DELTA_DEFINITION];

export function getDeltaByUpdateId(id: string): DeltaDefinition | undefined {
  return DELTA_DEFINITIONS.find(d => d.update_id === id);
}

/**
 * Return the active delta for a module. When more than one delta ever targets
 * the same module, prefer the one whose window has not closed at `now`, using
 * the release gate's later-of(GA, deployment) point + `delta_window_days`.
 * Definitions whose release gate is unconfigured (no resolver available) sort
 * last so a configured, open delta always wins. Today there is a single S2
 * delta, so this resolves to it.
 *
 * `releaseResolver` lets the caller supply the release gate (read from
 * system_settings) without this config module depending on the DB layer.
 */
export function getDeltaForModule(
  moduleId: string,
  options?: {
    now?: Date;
    releaseResolver?: (def: DeltaDefinition) => { adcp_3_1_ga_at: string | null; criteria_deployed_at: string | null } | null;
  },
): DeltaDefinition | undefined {
  const candidates = DELTA_DEFINITIONS.filter(d => d.module_id === moduleId);
  if (candidates.length <= 1) return candidates[0];

  const now = options?.now ?? new Date();
  const resolver = options?.releaseResolver;

  const windowClosesAt = (def: DeltaDefinition): number | null => {
    const release = resolver?.(def);
    if (!release) return null;
    const ga = release.adcp_3_1_ga_at ? new Date(release.adcp_3_1_ga_at).getTime() : NaN;
    const deployed = release.criteria_deployed_at ? new Date(release.criteria_deployed_at).getTime() : NaN;
    if (Number.isNaN(ga) || Number.isNaN(deployed)) return null;
    const effective = Math.max(ga, deployed);
    return effective + def.delta_window_days * 24 * 60 * 60 * 1000;
  };

  // Prefer definitions whose window is still open; among those, the one
  // closing soonest (most specific to the current change). Definitions with an
  // unknown/unconfigured window fall to the back.
  const open = candidates
    .map(def => ({ def, closesAt: windowClosesAt(def) }))
    .filter(({ closesAt }) => closesAt !== null && closesAt >= now.getTime())
    .sort((a, b) => (a.closesAt! - b.closesAt!));

  return open[0]?.def ?? candidates[0];
}
