import Ajv from 'ajv';
import addFormats from 'ajv-formats';
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
  const definitions = canonicalDefinitions(suite);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  for (const trace of suite.filter((candidate) => candidate.phase === 'tuning' && candidate.toolFixtures.length > 0)) {
    const contract = trace.toolContract;
    if (!contract) {
      failures.push(`missing_contract:${trace.id}`);
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
}
