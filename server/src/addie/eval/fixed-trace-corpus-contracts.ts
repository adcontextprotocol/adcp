import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { ADMIN_TOOLS } from '../mcp/admin-tools.js';
import { BILLING_TOOLS } from '../mcp/billing-tools.js';
import { BRAND_CANONICAL_TOOLS } from '../mcp/brand-canonical-tools.js';
import { COMMITTEE_LEADER_TOOLS } from '../mcp/committee-leader-tools.js';
import { DIRECTORY_TOOLS } from '../mcp/directory-tools.js';
import { ILLUSTRATION_TOOLS } from '../mcp/illustration-tools.js';
import { KNOWLEDGE_TOOLS } from '../mcp/knowledge-search.js';
import { MEETING_TOOLS } from '../mcp/meeting-tools.js';
import { MEMBER_TOOLS } from '../mcp/member-tools.js';
import { PROPERTY_TOOLS } from '../mcp/property-tools.js';
import { SI_HOST_TOOLS } from '../mcp/si-host-tools.js';
import type { AddieTool } from '../types.js';
import type { FixedTraceCorpusCase } from './fixed-trace-suite.js';
import {
  FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY,
  type FixedTraceTuningSemanticAuthorityEntry,
} from './fixed-trace-corpus-authority.js';
import { detachFixedTraceSnapshot } from './fixed-trace-corpus-snapshot.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Fixed trace authority contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Fixed trace authority contains a non-JSON value');
}

/**
 * A complete canonical trace is compared with a literal reviewer manifest.
 * Do not reduce this to selected fields: routing, grading, candidate input,
 * and evaluator controls are all behavior-defining corpus semantics.
 */
export function fixedTraceTuningSemanticSha256(trace: FixedTraceCorpusCase): string {
  const detached = detachFixedTraceSnapshot(trace);
  if (!detached.snapshot) throw new Error(`Unsafe tuning semantic input: ${detached.error}`);
  return createHash('sha256').update(canonicalJson(detached.snapshot), 'utf8').digest('hex');
}

const TEXT_CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  '\u0430': 'a', '\u0435': 'e', '\u0456': 'i', '\u0458': 'j', '\u043a': 'k', '\u043e': 'o', '\u043f': 'n', '\u0440': 'p', '\u0441': 'c', '\u0442': 't', '\u0445': 'x', '\u0443': 'y',
  '\u0432': 'b', '\u0455': 's', '\u04cf': 'l',
  '\u0131': 'i',
  '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b7': 'n', '\u03b9': 'i', '\u03ba': 'k', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'y', '\u03c7': 'x',
  // The corpus only folds reviewed lookalikes.  Lambda is included because it
  // has appeared in an attempted spelling of a protected surname; this is not
  // intended to be a general transliteration table.
  '\u03bb': 'l',
});

const MAX_PERCENT_DECODE_ROUNDS = 2;
const SAFE_HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', nbsp: ' ', period: '.', dot: '.', newline: ' ', sol: '/', tab: ' ', percnt: '%',
});

function decodePercentEscapes(value: string): { value: string; changed: boolean; malformed: boolean } {
  let output = '';
  let changed = false;
  let malformed = false;
  for (let index = 0; index < value.length;) {
    if (value[index] !== '%') {
      output += value[index++];
      continue;
    }
    const encoded = value.slice(index, index + 3);
    if (/^%[0-9a-f]{2}$/i.test(encoded)) {
      let end = index + 3;
      while (/^%[0-9a-f]{2}$/i.test(value.slice(end, end + 3))) end += 3;
      try {
        output += decodeURIComponent(value.slice(index, end));
        changed = true;
      } catch {
        malformed = true;
        output += value.slice(index, end);
      }
      index = end;
      continue;
    }
    // Literal percentages are ordinary text (for example, "50% discount").
    // A percent followed by an alphanumeric token is an attempted, malformed
    // escape and must not silently bypass a protected value check.
    if (/^[a-z0-9]$/i.test(value[index + 1] ?? '')) malformed = true;
    output += value[index++];
  }
  return { value: output, changed, malformed };
}

function decodeHtmlEntities(value: string): { value: string; changed: boolean; malformed: boolean } {
  let changed = false;
  let malformed = false;
  let decoded = value.replace(/&#(?:x[0-9a-f]{1,6}|[0-9]{1,7});/gi, (entity) => {
    const numeric = entity.slice(2, -1);
    const codePoint = numeric[0].toLowerCase() === 'x'
      ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      malformed = true;
      return entity;
    }
    changed = true;
    return String.fromCodePoint(codePoint);
  });
  // Deliberately small named-entity set: only separators that can conceal a
  // protected identity, domain, or evaluator marker are decoded.
  decoded = decoded.replace(/&(amp|nbsp|period|dot|newline|sol|tab|percnt);/gi, (entity, name: string) => {
    changed = true;
    return SAFE_HTML_ENTITIES[name.toLowerCase()]!;
  });
  if (/&#(?:x[0-9a-z]{0,8}|[0-9a-z]{0,8});?/i.test(decoded)) malformed = true;
  // Unknown complete entities and malformed spellings of supported separator
  // entities are encoding attempts, not ordinary prose. Mark them unsafe
  // rather than allowing a new separator spelling to evade all consumers.
  if (/&[a-z][a-z0-9]{1,31};/i.test(decoded)
    || /&(amp|nbsp|period|dot|newline|sol|tab|percnt)(?!;)/i.test(decoded)) malformed = true;
  return { value: decoded, changed, malformed };
}

export interface FixedTraceCanonicalText {
  /** Lowercase, deobfuscated text suitable for bounded policy matching. */
  text: string;
  /** Separator-free form for protected multi-token identity and marker matching. */
  compact: string;
  /** Malformed or still-encoded data is rejected by consumers rather than ignored. */
  malformedPercentEncoding: boolean;
}

/**
 * Canonicalize an individual raw text leaf before safety checks. This is
 * deliberately bounded: two valid decode passes cover ordinary double
 * encoding, while malformed or further-encoded input remains fail-closed.
 */
export function canonicalFixedTraceText(value: string): FixedTraceCanonicalText {
  let text = value.normalize('NFKC');
  let malformedPercentEncoding = false;
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round++) {
    const percent = decodePercentEscapes(text);
    const entities = decodeHtmlEntities(percent.value);
    text = entities.value;
    malformedPercentEncoding ||= percent.malformed || entities.malformed;
    if (!percent.changed && !entities.changed) break;
  }
  // A third encoding layer is intentionally unsupported rather than silently
  // accepted. It might otherwise conceal an evaluator marker or identity.
  const unresolvedPercent = decodePercentEscapes(text);
  const unresolvedEntity = decodeHtmlEntities(text);
  if (unresolvedPercent.changed || unresolvedPercent.malformed || unresolvedEntity.changed || unresolvedEntity.malformed) {
    malformedPercentEncoding = true;
  }

  text = text.normalize('NFKD').toLocaleLowerCase('en-US').replace(/\p{M}/gu, '');
  for (const [confusable, replacement] of Object.entries(TEXT_CONFUSABLES)) text = text.replaceAll(confusable, replacement);
  text = text
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}/g, '.')
    .replace(/\b(?:dot|period)\b/g, '.')
    .replace(/[\[\]{}()]/g, '');
  return {
    text,
    compact: text.replace(/[^a-z0-9]+/g, ''),
    malformedPercentEncoding,
  };
}

/**
 * Snapshot callers guarantee inert plain data. Include property names so an
 * identity or evaluator marker cannot hide in an otherwise benign key.
 */
function rawTextFragments(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(rawTextFragments);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...rawTextFragments(nested)]);
  }
  return [];
}

function normalizeMarker(value: string): string {
  return canonicalFixedTraceText(value).compact;
}

/** Normalize raw candidate leaves, never a JSON-escaped aggregate. */
export function candidateVisibleMarkerOverlap(value: unknown, markers: readonly string[]): string[] {
  const detached = detachFixedTraceSnapshot(value);
  // This helper has no error channel. Returning every protected marker makes
  // callers reject unsafe candidate input rather than inspecting attacker
  // accessors or treating malformed object shapes as an empty overlap.
  if (!detached.snapshot) return [...markers];
  const canonicalValues = rawTextFragments(detached.snapshot).map(canonicalFixedTraceText);
  return markers.filter((marker) => {
    const normalizedMarker = normalizeMarker(marker);
    return normalizedMarker.length >= 5 && canonicalValues.some((candidate) => candidate.malformedPercentEncoding
      || candidate.compact.includes(normalizedMarker));
  });
}

function inputScalarLeaves(value: unknown, path = '$'): Array<{ path: string; value: string | number | boolean | null }> {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{ path, value }];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => inputScalarLeaves(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => inputScalarLeaves(item, `${path}.${key}`));
  }
  return [];
}

function candidateContainsInputValue(candidate: unknown, value: string): boolean {
  const expected = canonicalFixedTraceText(value);
  if (!expected.compact) return true;
  return rawTextFragments(candidate).some((fragment) => {
    const available = canonicalFixedTraceText(fragment);
    return available.malformedPercentEncoding || available.compact.includes(expected.compact);
  });
}

function receiptContainsInputValue(
  trace: FixedTraceCorpusCase,
  callIndex: number,
  value: string,
): boolean {
  const call = trace.toolContract?.orderedCalls[callIndex];
  const dependency = call?.dependsOn;
  if (!dependency || dependency.callIndex >= callIndex) return false;
  const fixtureIndex = trace.toolContract!.orderedCalls.slice(0, dependency.callIndex + 1)
    .filter((entry) => entry.execution === 'executed').length - 1;
  const receipt = trace.toolFixtures[fixtureIndex]?.result;
  return typeof receipt === 'string' && candidateContainsInputValue({ receipt }, value);
}

function evaluatorOnlyInputAuthorityValid(trace: FixedTraceCorpusCase): boolean {
  if (trace.phase !== 'tuning') return false;
  const authority = FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY.find((entry) => entry.id === trace.id);
  return Boolean(authority && fixedTraceTuningSemanticSha256(trace) === authority.semanticSha256);
}

/**
 * Every replay-input leaf has exactly one provenance class: candidate text,
 * a declared prior receipt, or an explicitly evaluator-only leaf. The walker
 * covers nested objects and arrays in every phase; a path declaration is only
 * an exception for a private leaf, never a bypass for the rest of an input.
 * Schema-shaped number/boolean/null leaves are evaluator structural controls
 * and cannot carry a hidden textual identity or grading instruction.
 */
export function validateFixedTraceCandidateInputProvenance(
  suite: ReadonlyArray<FixedTraceCorpusCase>,
): string[] {
  const detached = detachFixedTraceSnapshot(suite);
  if (!detached.snapshot) return [`unsafe_candidate_input_provenance:${detached.error}`];
  if (!Array.isArray(detached.snapshot)) return ['unsafe_candidate_input_provenance:non_plain_object'];
  const snapshot = detached.snapshot as ReadonlyArray<FixedTraceCorpusCase>;
  try {
  const failures: string[] = [];
  for (const trace of snapshot) {
    const visible = candidateInput(trace);
    for (const [callIndex, call] of (trace.toolContract?.orderedCalls ?? []).entries()) {
      const leaves = inputScalarLeaves(call.input);
      const leavesByPath = new Map(leaves.map((leaf) => [leaf.path, leaf]));
      const evaluatorOnlyPaths = new Set(call.evaluatorOnlyInputPaths ?? []);
      const privateAuthorityValid = evaluatorOnlyPaths.size === 0 || evaluatorOnlyInputAuthorityValid(trace);
      for (const path of evaluatorOnlyPaths) {
        if (!leavesByPath.has(path)) {
          failures.push(`invalid_evaluator_only_input_path:${trace.id}:${callIndex}:${path}`);
        }
      }
      for (const leaf of leaves) {
        if (typeof leaf.value !== 'string') continue;
        if (evaluatorOnlyPaths.has(leaf.path)) {
          if (candidateContainsInputValue(visible, leaf.value)) {
            failures.push(`evaluator_input_visible:${trace.id}:${callIndex}:${leaf.path}`);
          }
          if (!privateAuthorityValid) {
            failures.push(`evaluator_input_authority_mismatch:${trace.id}:${callIndex}:${leaf.path}`);
          }
          continue;
        }
        if (!candidateContainsInputValue(visible, leaf.value)
          && !receiptContainsInputValue(trace, callIndex, leaf.value)) {
          failures.push(`unproven_contract_input:${trace.id}:${callIndex}:${leaf.path}`);
        }
      }
    }
  }
  return failures;
  } catch {
    return ['unsafe_candidate_input_provenance:invalid_structure'];
  }
}

function candidateInput(trace: FixedTraceCorpusCase): { request: FixedTraceCorpusCase['request'] } {
  const request = trace.request;
  return {
    request: {
      source: request.source,
      message: request.message,
      nowUtc: request.nowUtc,
      isAdmin: request.isAdmin,
      ...(request.threadContext ? { threadContext: request.threadContext.map(({ user, text }) => ({ user, text })) } : {}),
    },
  };
}

/** The corpus cannot authorize its own semantics: all tuning cases need a reviewer record. */
export function validateFixedTraceCorpusSemanticAuthority(
  suite: ReadonlyArray<FixedTraceCorpusCase>,
  authority: readonly FixedTraceTuningSemanticAuthorityEntry[] = FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY,
): string[] {
  const failures: string[] = [];
  const detachedSuite = detachFixedTraceSnapshot(suite);
  if (!detachedSuite.snapshot) return [`unsafe_semantic_authority_input:${detachedSuite.error}`];
  if (!Array.isArray(detachedSuite.snapshot)) return ['unsafe_semantic_authority_input:non_plain_object'];
  const detachedAuthority = detachFixedTraceSnapshot(authority);
  if (!detachedAuthority.snapshot) return [`unsafe_semantic_authority_manifest:${detachedAuthority.error}`];
  if (!Array.isArray(detachedAuthority.snapshot)) return ['unsafe_semantic_authority_manifest:non_plain_object'];
  try {
  const authorityById = new Map<string, FixedTraceTuningSemanticAuthorityEntry>();
  for (const entry of detachedAuthority.snapshot) {
    if (authorityById.has(entry.id)) failures.push(`duplicate_semantic_authority:${entry.id}`);
    else authorityById.set(entry.id, entry);
  }
  const tuning = detachedSuite.snapshot.filter((trace) => trace.phase === 'tuning');
  const seen = new Set<string>();
  for (const trace of tuning) {
    const authorityEntry = authorityById.get(trace.id);
    if (!authorityEntry) {
      failures.push(`missing_semantic_authority:${trace.id}`);
      continue;
    }
    seen.add(trace.id);
    if (fixedTraceTuningSemanticSha256(trace) !== authorityEntry.semanticSha256) {
      failures.push(`semantic_authority_mismatch:${trace.id}`);
    }
    for (const marker of candidateVisibleMarkerOverlap(trace.request, authorityEntry.candidateVisibleForbiddenMarkers)) {
      failures.push(`candidate_marker_overlap:${trace.id}:${marker}`);
    }
  }
  for (const id of authorityById.keys()) {
    if (!seen.has(id)) failures.push(`orphan_semantic_authority:${id}`);
  }
  return failures;
  } catch {
    return ['unsafe_semantic_authority_input:invalid_structure'];
  }
}

const CANONICAL_SOURCES: readonly (readonly AddieTool[])[] = [
  KNOWLEDGE_TOOLS, MEMBER_TOOLS, ADMIN_TOOLS, BILLING_TOOLS, MEETING_TOOLS,
  BRAND_CANONICAL_TOOLS, COMMITTEE_LEADER_TOOLS, DIRECTORY_TOOLS,
  ILLUSTRATION_TOOLS, PROPERTY_TOOLS, SI_HOST_TOOLS,
];

function canonicalDefinitions(traces: ReadonlyArray<FixedTraceCorpusCase>): Map<string, AddieTool> {
  const required = new Set(traces.flatMap((trace) => [
    ...trace.toolFixtures.map((fixture) => fixture.name),
    ...(trace.toolContract?.orderedCalls.map((call) => call.name) ?? []),
  ]));
  const definitions = new Map<string, AddieTool>();
  for (const source of CANONICAL_SOURCES) for (const definition of source) {
    if (!required.has(definition.name)) continue;
    if (definitions.has(definition.name)) throw new Error(`Duplicate canonical tool definition: ${definition.name}`);
    definitions.set(definition.name, definition);
  }
  return definitions;
}

/**
 * Corpus-only canonical-schema audit. It is intentionally not imported by the
 * live runner: planner integration owns execution of these new contracts.
 */
export function validateFixedTraceCorpusToolContracts(
  suite: ReadonlyArray<FixedTraceCorpusCase>,
): string[] {
  const failures: string[] = [];
  const detachedSuite = detachFixedTraceSnapshot(suite);
  if (!detachedSuite.snapshot) return [`unsafe_tool_contract_input:${detachedSuite.error}`];
  if (!Array.isArray(detachedSuite.snapshot)) return ['unsafe_tool_contract_input:non_plain_object'];
  suite = detachedSuite.snapshot;
  try {
  const definitions = canonicalDefinitions(suite);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  for (const trace of suite.filter((candidate) => candidate.toolContract)) {
    const contract = trace.toolContract;
    if (!contract) {
      if (trace.toolFixtures.length > 0) failures.push(`missing_contract:${trace.id}`);
      continue;
    }
    if (!trace.caseControl || contract.callBudget !== trace.caseControl.maxToolCalls
      || contract.terminalBoundary !== trace.caseControl.terminalBoundary
      || contract.maxOutputTokens !== trace.caseControl.maxOutputTokens) {
      failures.push(`execution_plan_mismatch:${trace.id}`);
    }
    if (contract.maxOutputTokens !== undefined && (!Number.isInteger(contract.maxOutputTokens)
      || contract.maxOutputTokens < 1 || contract.maxOutputTokens > 512)) {
      failures.push(`invalid_output_budget:${trace.id}`);
    }
    if (contract.orderedCalls.length > contract.callBudget) {
      failures.push(`call_budget_exceeded:${trace.id}`);
    }
    for (const required of contract.requiredReceiptDependencies) {
      const call = contract.orderedCalls[required.callIndex];
      if (!call || JSON.stringify(call.dependsOn) !== JSON.stringify(required.dependsOn)) {
        failures.push(`required_receipt_dependency_mismatch:${trace.id}:${required.callIndex}`);
      }
    }
    if (contract.negativeFixtureScenario === 'provider_failure_before_tools') {
      if (trace.toolFixtures.length !== 0) failures.push(`unreachable_fixture:${trace.id}`);
      if (contract.orderedCalls.length !== 0) failures.push(`provider_failure_call:${trace.id}`);
      continue;
    }
    let fixtureIndex = 0;
    for (const [index, call] of contract.orderedCalls.entries()) {
      const definition = definitions.get(call.name);
      if (!definition) {
        failures.push(`missing_canonical_tool:${trace.id}:${call.name}`);
        continue;
      }
      const validate = ajv.compile(definition.input_schema);
      if (!validate(call.input)) failures.push(`invalid_contract_input:${trace.id}:${call.name}:${index}`);
      if (call.execution === 'blocked') {
        if (call.policyDisposition !== 'blocked') failures.push(`blocked_disposition_mismatch:${trace.id}:${index}`);
        continue;
      }
      if (call.execution !== 'executed' || call.policyDisposition !== 'allowed') {
        failures.push(`execution_policy_mismatch:${trace.id}:${index}`);
        continue;
      }
      const fixture = trace.toolFixtures[fixtureIndex++];
      if (!fixture || fixture.name !== call.name || fixture.resultStatus !== call.resultStatus) {
        failures.push(`ordered_fixture_mismatch:${trace.id}:${index}`);
        continue;
      }
      if (call.dependsOn) {
        const prior = contract.orderedCalls[call.dependsOn.callIndex];
        const priorFixture = prior?.execution === 'executed'
          ? trace.toolFixtures[contract.orderedCalls.slice(0, call.dependsOn.callIndex + 1)
            .filter((entry) => entry.execution === 'executed').length - 1]
          : undefined;
        if (!priorFixture || call.dependsOn.callIndex >= index || !priorFixture.result.includes(call.dependsOn.requiredResultMarker)) {
          failures.push(`invalid_receipt_dependency:${trace.id}:${index}`);
        }
      }
      if (call.policyDisposition === 'allowed' && fixture.effect === 'mutation' && trace.expectation.mutationAuthorization !== 'confirmed') {
        failures.push(`unauthorized_mutation_contract:${trace.id}:${index}`);
      }
    }
    if (fixtureIndex !== trace.toolFixtures.length) failures.push(`unconsumed_fixture:${trace.id}`);
  }
  return failures;
  } catch {
    return ['unsafe_tool_contract_input:invalid_structure'];
  }
}
