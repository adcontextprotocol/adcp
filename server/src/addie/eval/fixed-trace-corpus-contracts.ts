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
  '\u0430': 'a', '\u0435': 'e', '\u0456': 'i', '\u0458': 'j', '\u043a': 'k', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't', '\u0445': 'x', '\u0443': 'y',
  '\u0432': 'b', '\u0455': 's', '\u04cf': 'l',
  '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b7': 'n', '\u03b9': 'i', '\u03ba': 'k', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'y', '\u03c7': 'x',
});

const MAX_PERCENT_DECODE_ROUNDS = 2;

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
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS && text.includes('%'); round++) {
    if (/%(?![0-9a-fA-F]{2})/.test(text)) {
      malformedPercentEncoding = true;
      break;
    }
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch {
      malformedPercentEncoding = true;
      break;
    }
  }
  // A third encoding layer is intentionally unsupported rather than silently
  // accepted. It might otherwise conceal an evaluator marker or identity.
  if (text.includes('%')) malformedPercentEncoding = true;

  text = text.normalize('NFKD').toLocaleLowerCase('en-US').replace(/\p{M}/gu, '');
  for (const [confusable, replacement] of Object.entries(TEXT_CONFUSABLES)) text = text.replaceAll(confusable, replacement);
  text = text
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}/g, '.')
    .replace(/[\[\]{}()]/g, '');
  return {
    text,
    compact: text.replace(/[^a-z0-9]+/g, ''),
    malformedPercentEncoding,
  };
}

function rawStringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(rawStringLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(rawStringLeaves);
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
  const canonicalValues = rawStringLeaves(detached.snapshot).map(canonicalFixedTraceText);
  return markers.filter((marker) => {
    const normalizedMarker = normalizeMarker(marker);
    return normalizedMarker.length >= 5 && canonicalValues.some((candidate) => candidate.malformedPercentEncoding
      || candidate.compact.includes(normalizedMarker));
  });
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

  for (const trace of suite.filter((candidate) => candidate.phase === 'tuning')) {
    const contract = trace.toolContract;
    if (!contract) {
      if (trace.toolFixtures.length > 0) failures.push(`missing_contract:${trace.id}`);
      continue;
    }
    if (!trace.caseControl || contract.callBudget !== trace.caseControl.maxToolCalls
      || contract.terminalBoundary !== trace.caseControl.terminalBoundary) {
      failures.push(`execution_plan_mismatch:${trace.id}`);
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
