import type { ComplianceResult } from '@adcp/sdk/testing';
import { wrapUntrustedInput } from './untrusted-input.js';

type ComplianceFailure = NonNullable<ComplianceResult['failures']>[number];
type ComplianceValidation = NonNullable<ComplianceFailure['validation']>;

const MAX_INLINE_CHARS = 200;
const MAX_MESSAGE_CHARS = 400;
const MAX_NOTICES = 12;
const MAX_SHARED_FAILURES = 12;
const MAX_SCENARIO_FAILURES = 24;
const MAX_TRACKS = 20;
const MAX_OBSERVATIONS = 12;
const MAX_SHARED_COORDINATES = 6;
const NOTICES_CHAR_BUDGET = 3_500;
const SHARED_FAILURES_CHAR_BUDGET = 4_500;
const TRACKS_CHAR_BUDGET = 7_000;
const OBSERVATIONS_CHAR_BUDGET = 2_500;
const VALUE_IDENTITY_MAX_NODES = 200;
const VALUE_IDENTITY_MAX_CHARS = 8_000;

const SECRET_PATTERN =
  /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bbearer\s+\S+|\bbasic\s+[A-Za-z0-9+/=]{8,}|\b(?:authorization|auth|cookie|set-cookie|session(?:[_ -]?id)?|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|credential|private[_ -]?key|signing[_ -]?key|client[_ -]?secret|oauth[_ -]?(?:code|verifier)|jwt)\b\s*[:=]\s*\S+|\bsk_(?:live|test)_[A-Za-z0-9_]{12,}|\bgh[pousr]_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{12,})/i;
const PROMPT_INJECTION_PATTERN =
  /(ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|system\s*[:\s]prompt|developer\s+message|tool\s+result|reveal\s+(?:the\s+)?(?:secret|prompt)|exfiltrate|<\s*system\b)/i;

function cleanText(value: unknown, maxChars = MAX_INLINE_CHARS): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFKC')
    .replace(/[`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  if (!cleaned) return '';
  if (SECRET_PATTERN.test(cleaned) || PROMPT_INJECTION_PATTERN.test(cleaned)) return '[redacted]';
  return cleaned;
}

function cleanMarkdownLabel(value: unknown, maxChars = MAX_INLINE_CHARS): string {
  return cleanText(value, maxChars).replace(/[\\*#[\]<>|]/g, ' ');
}

function fencedText(value: unknown, maxChars = MAX_MESSAGE_CHARS): string {
  const cleaned = cleanText(value, maxChars);
  if (!cleaned || cleaned === '[redacted]') return '[redacted]';
  return wrapUntrustedInput(cleaned, maxChars);
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1_000) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    // Diagnostic links do not need caller-controlled query parameters or
    // fragments. Drop both so signed URLs, OAuth codes, and other credentials
    // cannot leak into Addie's LLM-facing context.
    parsed.search = '';
    parsed.hash = '';
    const rendered = parsed.toString();
    if (rendered.length > 300) return undefined;
    let decoded = rendered;
    try {
      decoded = decodeURIComponent(rendered);
    } catch {
      return undefined;
    }
    if (SECRET_PATTERN.test(decoded) || PROMPT_INJECTION_PATTERN.test(decoded)) return undefined;
    return rendered;
  } catch {
    return undefined;
  }
}

function formatDiagnosticValue(value: unknown): string {
  if (value === undefined) return '[undefined]';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '[non-finite number]';
  if (typeof value === 'string') return fencedText(value, MAX_INLINE_CHARS);
  if (Array.isArray(value) && value.length <= 8 && value.every(item =>
    item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
    return `[${value.map(item => formatDiagnosticValue(item)).join(', ')}]`;
  }
  return '[structured value omitted]';
}

interface ValueIdentityBudget {
  nodes: number;
  chars: number;
}

function boundedValueIdentity(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: ValueIdentityBudget = { nodes: 0, chars: 0 },
): string | undefined {
  budget.nodes += 1;
  if (budget.nodes > VALUE_IDENTITY_MAX_NODES) return undefined;
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  if (typeof value === 'boolean') return value ? 'b1' : 'b0';
  if (typeof value === 'number') return `d${Object.is(value, -0) ? '-0' : String(value)}`;
  if (typeof value === 'string') {
    budget.chars += value.length;
    return value.length <= 2_000 && budget.chars <= VALUE_IDENTITY_MAX_CHARS
      ? `s${value.length}:${value}`
      : undefined;
  }
  if (typeof value !== 'object' || depth >= 5 || seen.has(value)) return undefined;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 40) return undefined;
      const parts: string[] = [];
      for (const item of value) {
        const identity = boundedValueIdentity(item, depth + 1, seen, budget);
        if (identity === undefined) return undefined;
        parts.push(`${identity.length}:${identity}`);
      }
      const identity = `a${parts.join('')}`;
      return identity.length <= VALUE_IDENTITY_MAX_CHARS ? identity : undefined;
    }

    const record = value as Record<string, unknown>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (keys.length >= 40) return undefined;
      keys.push(key);
    }
    keys.sort((a, b) => a.localeCompare(b));
    const parts: string[] = [];
    for (const key of keys) {
      if (key.length > 200) return undefined;
      budget.chars += key.length;
      if (budget.chars > VALUE_IDENTITY_MAX_CHARS) return undefined;
      const identity = boundedValueIdentity(record[key], depth + 1, seen, budget);
      if (identity === undefined) return undefined;
      parts.push(`${key.length}:${key}${identity.length}:${identity}`);
    }
    const identity = `o${parts.join('')}`;
    return identity.length <= VALUE_IDENTITY_MAX_CHARS ? identity : undefined;
  } finally {
    seen.delete(value);
  }
}

function valuesMatch(values: unknown[]): boolean {
  if (values.length < 2) return true;
  const first = boundedValueIdentity(values[0]);
  return first !== undefined && values.slice(1).every(value => boundedValueIdentity(value) === first);
}

function normalizeSemanticField(value: unknown): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 2_000) return undefined;
  return value.replace(/\s+/g, ' ').trim();
}

function semanticFingerprint(validation: ComplianceValidation): string | undefined {
  const values = [
    validation.check,
    validation.json_pointer,
    validation.schema_id,
    validation.schema_url,
    validation.description,
  ].map(normalizeSemanticField);
  if (values.some(value => value === undefined) || !values[0] || !values[4]) return undefined;
  return values.map(value => `${value!.length}:${value}`).join('');
}

function failureCoordinate(failure: ComplianceFailure): string {
  return `${failure.track}\u0000${failure.storyboard_id}\u0000${failure.step_id}`;
}

function displayCoordinate(failure: ComplianceFailure): string {
  const storyboard = cleanMarkdownLabel(failure.storyboard_id, 120) || '[unknown storyboard]';
  const step = cleanMarkdownLabel(failure.step_id, 120) || cleanMarkdownLabel(failure.step_title, 120) || '[unknown step]';
  return `${storyboard} / ${step}`;
}

function formatValidationDetails(validation: ComplianceValidation, prefix: string): string {
  let output = '';
  const id = cleanText(validation.id, 160);
  if (id) output += `${prefix}Validation ID: ${fencedText(id, 160)}\n`;
  output += `${prefix}Check: ${fencedText(validation.check, 120)}\n`;
  if (validation.json_pointer !== undefined && validation.json_pointer !== null) {
    output += `${prefix}JSON pointer: ${fencedText(validation.json_pointer, 200)}\n`;
  }
  if (validation.expected !== undefined) {
    output += `${prefix}Expected: ${formatDiagnosticValue(validation.expected)}\n`;
  }
  if (validation.actual !== undefined) {
    output += `${prefix}Actual: ${formatDiagnosticValue(validation.actual)}\n`;
  }
  if (validation.schema_id) output += `${prefix}Schema ID: ${fencedText(validation.schema_id, 200)}\n`;
  if (validation.schema_url) {
    const schemaUrl = safeHttpUrl(validation.schema_url);
    output += `${prefix}Schema URL: ${schemaUrl ?? '[redacted]'}\n`;
  }
  output += `${prefix}Detail: ${fencedText(validation.description, MAX_MESSAGE_CHARS)}\n`;
  return output;
}

interface SharedFailureGroup {
  fingerprint: string;
  entries: Array<{ failure: ComplianceFailure; index: number }>;
  coordinates: Set<string>;
}

function collectSharedFailureGroups(failures: ComplianceFailure[]): SharedFailureGroup[] {
  const groups = new Map<string, SharedFailureGroup>();
  failures.forEach((failure, index) => {
    if (!failure.validation) return;
    const fingerprint = semanticFingerprint(failure.validation);
    if (!fingerprint) return;
    const existing = groups.get(fingerprint) ?? {
      fingerprint,
      entries: [],
      coordinates: new Set<string>(),
    };
    existing.entries.push({ failure, index });
    existing.coordinates.add(failureCoordinate(failure));
    groups.set(fingerprint, existing);
  });
  return [...groups.values()].filter(group => group.coordinates.size >= 2);
}

function formatSharedFailure(group: SharedFailureGroup, trackLabels: Map<string, string>): string {
  const validations = group.entries.map(entry => entry.failure.validation!);
  const first = validations[0];
  const ids = validations.map(validation => validation.id);
  const tracks = [...new Set(group.entries.map(entry => entry.failure.track))]
    .map(track => trackLabels.get(track) ?? (cleanMarkdownLabel(track, 120) || '[unknown track]'));
  const coordinates = [...new Map(group.entries.map(entry => [
    failureCoordinate(entry.failure),
    displayCoordinate(entry.failure),
  ])).values()];

  let output = `- ${fencedText(first.description, MAX_MESSAGE_CHARS)}\n`;
  output += `  - Affected tracks: ${tracks.join(', ')}\n`;
  if (ids.every(id => id === undefined)) {
    // Validation ids are optional and are not part of the semantic grouping
    // key. Avoid implying disagreement when none of the emitters supplied one.
  } else if (valuesMatch(ids) && first.id) {
    output += `  - Validation ID: ${fencedText(first.id, 160)}\n`;
  } else {
    output += `  - Validation IDs vary by scenario.\n`;
  }
  output += `  - Check: ${fencedText(first.check, 120)}\n`;
  if (first.json_pointer !== undefined && first.json_pointer !== null) {
    output += `  - JSON pointer: ${fencedText(first.json_pointer, 200)}\n`;
  }
  if (first.schema_id) output += `  - Schema ID: ${fencedText(first.schema_id, 200)}\n`;
  if (first.schema_url) output += `  - Schema URL: ${safeHttpUrl(first.schema_url) ?? '[redacted]'}\n`;

  const expectedValues = validations.map(validation => validation.expected);
  const expectedPresent = expectedValues.some(value => value !== undefined);
  if (expectedPresent) {
    output += valuesMatch(expectedValues)
      ? `  - Expected: ${formatDiagnosticValue(expectedValues[0])}\n`
      : `  - Expected varies by scenario.\n`;
  }

  const actualValues = validations.map(validation => validation.actual);
  const actualPresent = actualValues.some(value => value !== undefined);
  if (actualPresent) {
    output += valuesMatch(actualValues)
      ? `  - Actual: ${formatDiagnosticValue(actualValues[0])}\n`
      : `  - Actual varies by scenario.\n`;
  }

  const shownCoordinates = coordinates.slice(0, MAX_SHARED_COORDINATES);
  output += `  - Seen in: ${shownCoordinates.join('; ')}`;
  if (coordinates.length > shownCoordinates.length) {
    output += `; ... and ${coordinates.length - shownCoordinates.length} more`;
  }
  return `${output}\n`;
}

function noticeSortRank(severity: unknown): number {
  if (severity === 'future_required') return 0;
  if (severity === 'deprecation') return 1;
  if (severity === 'info') return 2;
  return 3;
}

function noticeIdentity(notice: ComplianceResult['notices'][number], index: number): string {
  if (typeof notice.code !== 'string' || notice.code.length > 1_000) return `index:${index}`;
  const pointer = typeof notice.capability_pointer === 'string' && notice.capability_pointer.length <= 1_000
    ? notice.capability_pointer
    : undefined;
  return pointer === undefined ? notice.code : `${notice.code}\u0000${pointer}`;
}

function formatNotice(notice: ComplianceResult['notices'][number]): string {
  const severity = cleanMarkdownLabel(notice.severity, 80) || 'info';
  const code = cleanText(notice.code, 160) || '[redacted]';
  let output = `- [${severity.toUpperCase()}] ${fencedText(code, 160)}\n`;
  output += `  Message: ${fencedText(notice.message, MAX_MESSAGE_CHARS)}\n`;
  if (notice.effective_version) {
    output += `  Effective version: ${fencedText(notice.effective_version, 80)}\n`;
  }
  if (notice.capability_path) {
    output += `  Capability path: ${fencedText(notice.capability_path, 200)}\n`;
  }
  if (notice.capability_pointer) {
    output += `  Capability pointer: ${fencedText(notice.capability_pointer, 200)}\n`;
  }
  const docsUrl = safeHttpUrl(notice.docs_url);
  if (docsUrl) output += `  Documentation: ${docsUrl}\n`;
  return output;
}

function renderBoundedRecords(
  heading: string,
  records: string[],
  maxRecords: number,
  charBudget: number,
  omittedLabel: string,
): string {
  if (records.length === 0) return '';
  const output: string[] = [];
  let chars = 0;
  let shown = 0;
  for (const record of records) {
    if (shown >= maxRecords || chars + record.length > charBudget) break;
    output.push(record);
    chars += record.length;
    shown += 1;
  }
  const omitted = records.length - shown;
  if (omitted > 0) output.push(`- ... ${omitted} additional ${omittedLabel} omitted.\n`);
  return `${heading}\n\n${output.join('')}\n`;
}

function formatScenarioFailure(failure: ComplianceFailure): string {
  const stepTitle = cleanMarkdownLabel(failure.step_title, 160) || cleanMarkdownLabel(failure.step_id, 120) || '[unknown step]';
  const storyboard = cleanMarkdownLabel(failure.storyboard_id, 120) || '[unknown storyboard]';
  let output = `  - FAILED: ${storyboard} / ${stepTitle}\n`;
  if (failure.error) output += `    - Error: ${fencedText(failure.error, MAX_MESSAGE_CHARS)}\n`;
  if (failure.validation) output += formatValidationDetails(failure.validation, '    - ');
  else if (failure.expected) output += `    - Expected behavior: ${fencedText(failure.expected, MAX_MESSAGE_CHARS)}\n`;
  return output;
}

function formatFallbackScenarioFailure(
  scenario: ComplianceResult['tracks'][number]['scenarios'][number],
): string {
  let output = `  - FAILED: ${cleanMarkdownLabel(scenario.scenario, 180) || '[unknown scenario]'}\n`;
  const failedSteps = (scenario.steps ?? []).filter(step => !step.passed);
  for (const step of failedSteps.slice(0, 3)) {
    output += `    - ${cleanMarkdownLabel(step.step, 160) || '[unknown step]'}`;
    if (step.error) output += `: ${fencedText(step.error, MAX_MESSAGE_CHARS)}`;
    output += '\n';
  }
  if (failedSteps.length > 3) output += `    - ... and ${failedSteps.length - 3} more steps\n`;
  return output;
}

function formatCapabilityTracks(
  result: ComplianceResult,
  sharedFailureIndexes: Set<number>,
): string {
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const shownTracks = tracks.slice(0, MAX_TRACKS);
  const failures = Array.isArray(result.failures) ? result.failures : undefined;
  const uniqueFailures = failures?.filter((_, index) => !sharedFailureIndexes.has(index)) ?? [];
  const totalScenarioFailures = failures === undefined
    ? tracks.reduce((count, track) => count + (
      Array.isArray(track.scenarios) ? track.scenarios.filter(scenario => !scenario.overall_passed).length : 0
    ), 0)
    : uniqueFailures.length;
  const failuresByTrack = new Map<string, ComplianceFailure[]>();
  for (const failure of uniqueFailures) {
    const list = failuresByTrack.get(failure.track) ?? [];
    list.push(failure);
    failuresByTrack.set(failure.track, list);
  }

  let output = `### Capability Tracks\n\n`;
  output += `**Summary:** ${fencedText(result.summary?.headline, MAX_MESSAGE_CHARS)}\n\n`;
  let chars = output.length;
  let shownFailures = 0;
  const renderedTrackIds = new Set<string>();
  const knownTrackIds = new Set<string>(tracks.map(track => track.track));
  const statusLabels: Record<string, string> = {
    pass: 'PASS', fail: 'FAIL', partial: 'PARTIAL', skip: 'SKIP', silent: 'SILENT',
  };

  for (const track of shownTracks) {
    const label = cleanMarkdownLabel(track.label, 160) || cleanMarkdownLabel(track.track, 120) || '[unknown track]';
    const rawStatus = typeof track.status === 'string' ? track.status : 'unknown';
    const status = statusLabels[rawStatus] ?? (cleanMarkdownLabel(rawStatus, 40).toUpperCase() || 'UNKNOWN');
    const scenarios = Array.isArray(track.scenarios) ? track.scenarios : [];
    const passedCount = scenarios.filter(scenario => scenario.overall_passed).length;
    const durationMs = Number.isFinite(track.duration_ms) ? Math.max(0, track.duration_ms) : 0;
    const summary = track.status === 'skip'
      ? `- **${label}** [${status}] — not applicable\n`
      : `- **${label}** [${status}] — ${passedCount}/${scenarios.length} scenarios pass (${(durationMs / 1000).toFixed(1)}s)\n`;
    if (chars + summary.length > TRACKS_CHAR_BUDGET) {
      break;
    }
    output += summary;
    chars += summary.length;
    renderedTrackIds.add(track.track);

    const records = failures === undefined
      ? scenarios.filter(scenario => !scenario.overall_passed).map(formatFallbackScenarioFailure)
      : (failuresByTrack.get(track.track) ?? []).map(formatScenarioFailure);
    for (const record of records) {
      if (shownFailures >= MAX_SCENARIO_FAILURES || chars + record.length > TRACKS_CHAR_BUDGET) {
        continue;
      }
      output += record;
      chars += record.length;
      shownFailures += 1;
    }
  }

  if (failures !== undefined) {
    for (const [track, trackFailures] of failuresByTrack) {
      if (renderedTrackIds.has(track)) continue;
      if (knownTrackIds.has(track)) continue;
      const label = cleanMarkdownLabel(track, 120) || '[unknown track]';
      const summary = `- **${label}** [FAIL] — failure details returned without a track summary\n`;
      if (chars + summary.length > TRACKS_CHAR_BUDGET) {
        continue;
      }
      output += summary;
      chars += summary.length;
      for (const failure of trackFailures) {
        const record = formatScenarioFailure(failure);
        if (shownFailures >= MAX_SCENARIO_FAILURES || chars + record.length > TRACKS_CHAR_BUDGET) {
          continue;
        }
        output += record;
        chars += record.length;
        shownFailures += 1;
      }
    }
  }

  const omittedTracks = tracks.length - renderedTrackIds.size;
  const omittedFailures = totalScenarioFailures - shownFailures;
  if (omittedTracks > 0) output += `- ... ${omittedTracks} additional tracks omitted.\n`;
  if (omittedFailures > 0) output += `- ... ${omittedFailures} additional scenario-specific failures omitted.\n`;
  return `${output}\n`;
}

function formatObservations(result: ComplianceResult): string {
  const observations = Array.isArray(result.observations) ? result.observations : [];
  const records = observations.map(observation => {
    const severity = cleanMarkdownLabel(observation.severity, 80) || 'info';
    const category = fencedText(observation.category, 120);
    const message = fencedText(observation.message, MAX_MESSAGE_CHARS);
    // Evidence can contain arbitrary agent responses and is intentionally not
    // rendered into Addie's LLM-facing tool result.
    return `- [${severity.toUpperCase()}] (${category}) ${message}\n`;
  });
  return renderBoundedRecords(
    '### Advisory Observations',
    records,
    MAX_OBSERVATIONS,
    OBSERVATIONS_CHAR_BUDGET,
    'advisory observations',
  );
}

/**
 * Format the compliance runner's diagnostic surfaces for Addie's LLM context.
 * All narrative and observed values cross an explicit untrusted-input boundary,
 * and each section has a fixed record/character budget.
 */
export function formatComplianceDiagnostics(result: ComplianceResult): string {
  const rawNotices = Array.isArray(result.notices) ? result.notices : [];
  const noticeMap = new Map<string, ComplianceResult['notices'][number]>();
  rawNotices.forEach((notice, index) => {
    const identity = noticeIdentity(notice, index);
    if (!noticeMap.has(identity)) noticeMap.set(identity, notice);
  });
  const notices = [...noticeMap.values()]
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => noticeSortRank(a.notice.severity) - noticeSortRank(b.notice.severity) || a.index - b.index)
    .map(({ notice }) => formatNotice(notice));

  const failures = Array.isArray(result.failures) ? result.failures : [];
  const sharedGroups = collectSharedFailureGroups(failures);
  const sharedFailureIndexes = new Set(sharedGroups.flatMap(group => group.entries.map(entry => entry.index)));
  const trackLabels = new Map(
    (Array.isArray(result.tracks) ? result.tracks : []).map(track => [
      track.track,
      cleanMarkdownLabel(track.label, 160) || cleanMarkdownLabel(track.track, 120) || '[unknown track]',
    ]),
  );
  const sharedRecords = sharedGroups.map(group => formatSharedFailure(group, trackLabels));

  return [
    renderBoundedRecords('### Notices', notices, MAX_NOTICES, NOTICES_CHAR_BUDGET, 'notices'),
    renderBoundedRecords('### Shared Failures', sharedRecords, MAX_SHARED_FAILURES, SHARED_FAILURES_CHAR_BUDGET, 'shared failures'),
    formatCapabilityTracks(result, sharedFailureIndexes),
    formatObservations(result),
  ].join('');
}
