/**
 * Semantic validation for AdCP 3.2 CTV ad-experience profiles.
 *
 * The server does not compile static/schemas/source/formats/canonical/*.json
 * with a JSON Schema validator at runtime, so the `x-adcp-validation`
 * conditionals authored on video_vast, native_in_feed, image, video_hosted,
 * and sponsored_placement (docs/creative/ctv-experiences.mdx) are not
 * enforced unless mirrored here. This module is that mirror: the single
 * source of truth for CTV experience semantics against a format
 * declaration's `params`, called from validateProductTarget in
 * task-handlers.ts.
 */

export type CtvViolation = {
  rule: string;
  field: string;
  expected?: unknown;
  predicted?: unknown;
};

type EffectiveSlot = {
  asset_group_id: string;
  asset_type: string;
};

/** Permitted ctv_ad_experience values per canonical. Canonicals absent from
 * this map (html5, display_tag, image_carousel, audio_hosted, audio_daast,
 * responsive_creative, agent_placement, custom, ...) never permit
 * ctv_ad_experience — any declared value on those canonicals is a violation.
 */
const CTV_EXPERIENCE_MATRIX: Record<string, readonly string[]> = {
  video_vast: ['pause', 'screensaver', 'overlay', 'squeezeback', 'in_scene'],
  native_in_feed: ['menu', 'overlay'],
  image: ['pause', 'screensaver'],
  video_hosted: ['screensaver'],
  sponsored_placement: ['menu', 'squeezeback', 'in_scene'],
};

/** Minimum duration (ms) for video_vast experiences that carry a floor.
 * `pause` and `screensaver` have no floor and are omitted.
 */
const VIDEO_VAST_DURATION_FLOOR_MS: Record<string, number> = {
  overlay: 10000,
  squeezeback: 10000,
  in_scene: 3000,
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function meetsDurationFloor(params: Record<string, unknown>, floorMs: number): boolean {
  const exact = params.duration_ms_exact;
  if (typeof exact === 'number' && exact >= floorMs) return true;
  const range = params.duration_ms_range;
  if (Array.isArray(range) && typeof range[0] === 'number' && range[0] >= floorMs) return true;
  return false;
}

/**
 * ctv_experience_matrix: ctv_ad_experience must be one of the values the
 * canonical's matrix permits. Canonicals with no entry in the matrix permit
 * no experience at all.
 */
export function ctvExperienceMatrixViolation(formatKind: string, params: Record<string, unknown>): CtvViolation | null {
  const experience = asString(params.ctv_ad_experience);
  if (!experience) return null;
  const allowed = CTV_EXPERIENCE_MATRIX[formatKind];
  if (allowed?.includes(experience)) return null;
  return {
    rule: 'ctv_experience_matrix',
    field: 'params.ctv_ad_experience',
    expected: allowed && allowed.length > 0 ? allowed : `ctv_ad_experience is not permitted on ${formatKind}`,
    predicted: experience,
  };
}

/**
 * video_vast per-experience constraints:
 * - ctv_ad_experience present -> creative_type required and must be "nonlinear".
 * - ctv_nonlinear_no_simid: every CTV experience forbids simid_supported;
 *   VAST carries InteractiveCreativeFile only under Linear MediaFiles.
 * - ctv_duration_floors: overlay/squeezeback >= 10000ms, in_scene >= 3000ms,
 *   pause/screensaver have no floor.
 * - ctv_in_scene_no_interactivity: in_scene additionally forbids vpaid_enabled.
 * - creative_type_precedence: linear_required: true contradicts
 *   creative_type nonlinear|either.
 */
export function videoVastCtvViolations(params: Record<string, unknown>): CtvViolation[] {
  const violations: CtvViolation[] = [];
  const experience = asString(params.ctv_ad_experience);

  if (experience) {
    const creativeType = params.creative_type;
    if (creativeType !== 'nonlinear') {
      violations.push({
        rule: 'ctv_experience_matrix',
        field: 'params.creative_type',
        expected: 'nonlinear',
        predicted: creativeType,
      });
    }

    if (params.simid_supported === true) {
      violations.push({
        rule: 'ctv_nonlinear_no_simid',
        field: 'params.simid_supported',
        expected: false,
        predicted: true,
      });
    }

    const floorMs = VIDEO_VAST_DURATION_FLOOR_MS[experience];
    if (floorMs !== undefined && !meetsDurationFloor(params, floorMs)) {
      violations.push({
        rule: 'ctv_duration_floors',
        field: params.duration_ms_exact !== undefined ? 'params.duration_ms_exact' : 'params.duration_ms_range',
        expected: `duration_ms_exact or duration_ms_range[0] >= ${floorMs}`,
        predicted: params.duration_ms_exact ?? params.duration_ms_range,
      });
    }

    if (experience === 'in_scene') {
      if (params.vpaid_enabled === true) {
        violations.push({
          rule: 'ctv_in_scene_no_interactivity',
          field: 'params.vpaid_enabled',
          expected: false,
          predicted: true,
        });
      }
    }
  }

  if (params.linear_required === true) {
    const creativeType = params.creative_type;
    if (creativeType === 'nonlinear' || creativeType === 'either') {
      violations.push({
        rule: 'creative_type_precedence',
        field: 'params.creative_type',
        expected: 'linear, or omit creative_type, when linear_required is true',
        predicted: creativeType,
      });
    }
  }

  return violations;
}

/**
 * native_in_feed menu profile:
 * - menu_profile_fields: menu_placement or focus_behavior require
 *   ctv_ad_experience: "menu".
 * - focus_video_pairing: focus_behavior autoplay_muted|autoplay_sound
 *   requires the effective slots to include a "video" asset group.
 *
 * The paired "menu + manifest video asset must be asset_type vast" rule is
 * enforced by the generic slot-type check in validateManifestSlots once the
 * native_in_feed default slots include the video/vast slot (see
 * CANONICAL_FORMAT_SLOTS in task-handlers.ts) — no separate check needed here.
 */
export function nativeInFeedCtvViolations(
  params: Record<string, unknown>,
  effectiveSlots: EffectiveSlot[]
): CtvViolation[] {
  const violations: CtvViolation[] = [];
  const experience = asString(params.ctv_ad_experience);
  const menuPlacement = params.menu_placement;
  const focusBehavior = asString(params.focus_behavior);

  if ((menuPlacement !== undefined || params.focus_behavior !== undefined) && experience !== 'menu') {
    violations.push({
      rule: 'menu_profile_fields',
      field: menuPlacement !== undefined ? 'params.menu_placement' : 'params.focus_behavior',
      expected: 'ctv_ad_experience: "menu"',
      predicted: experience,
    });
  }

  if (focusBehavior === 'autoplay_muted' || focusBehavior === 'autoplay_sound') {
    const hasVideoSlot = effectiveSlots.some(slot => slot.asset_group_id === 'video');
    if (!hasVideoSlot) {
      violations.push({
        rule: 'focus_video_pairing',
        field: 'params.focus_behavior',
        expected: 'effective slots include a "video" asset group',
        predicted: focusBehavior,
      });
    }
  }

  return violations;
}

/**
 * motion_level_static_canonical: motion_level "full_motion" is rejected on
 * the image canonical.
 */
export function imageCtvViolations(params: Record<string, unknown>): CtvViolation[] {
  if (params.motion_level === 'full_motion') {
    return [
      {
        rule: 'motion_level_static_canonical',
        field: 'params.motion_level',
        expected: 'static or limited_motion',
        predicted: 'full_motion',
      },
    ];
  }
  return [];
}

/**
 * Runs every applicable CTV semantic rule for a format declaration and
 * returns the combined violation list. `effectiveSlots` is the resolved
 * slots[] (params.slots override, or the canonical's default slots).
 */
export function ctvSemanticViolations(
  formatKind: string,
  params: Record<string, unknown>,
  effectiveSlots: EffectiveSlot[]
): CtvViolation[] {
  const violations: CtvViolation[] = [];

  const matrixViolation = ctvExperienceMatrixViolation(formatKind, params);
  if (matrixViolation) violations.push(matrixViolation);

  if (formatKind === 'video_vast') {
    violations.push(...videoVastCtvViolations(params));
  }
  if (formatKind === 'native_in_feed') {
    violations.push(...nativeInFeedCtvViolations(params, effectiveSlots));
  }
  if (formatKind === 'image') {
    violations.push(...imageCtvViolations(params));
  }

  return violations;
}
