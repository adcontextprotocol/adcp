/**
 * Policy evaluator using Claude for natural language policy compliance checks.
 *
 * Resolves policies from the registry, builds evaluation prompts from policy text
 * and exemplars, and returns structured findings.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { ModelConfig } from '../config/models.js';
import { bulkResolve, listPolicies, type Policy } from '../db/policies-db.js';
import type { Finding } from '../db/governance-db.js';

const logger = createLogger('policy-evaluator');

const anthropic = new Anthropic();

interface EvaluationContext {
  plan: {
    plan_id: string;
    objectives: string;
    countries: string[];
    regions: string[];
    channels_required: string[];
    channels_allowed: string[];
  };
  action: {
    tool?: string;
    payload?: Record<string, unknown>;
    planned_delivery?: Record<string, unknown>;
    delivery_metrics?: Record<string, unknown>;
  };
  binding: 'proposed' | 'committed';
  phase: string;
}

interface PolicyEvaluation {
  findings: Finding[];
  explanation: string;
}

/**
 * Build the evaluation prompt for a set of policies against an action.
 */
function buildEvaluationPrompt(policies: Policy[], context: EvaluationContext): string {
  const policyBlocks = policies.map(p => {
    let block = `### ${p.name} (${p.policy_id})\n`;
    block += `Category: ${p.category} | Enforcement: ${p.enforcement}\n`;
    if (p.jurisdictions.length > 0) block += `Jurisdictions: ${p.jurisdictions.join(', ')}\n`;
    if (p.verticals.length > 0) block += `Verticals: ${p.verticals.join(', ')}\n`;
    block += `\n${p.policy}\n`;

    if (p.exemplars) {
      if (p.exemplars.pass?.length) {
        block += `\nCompliant examples:\n`;
        for (const ex of p.exemplars.pass) {
          block += `- ${ex.scenario}: ${ex.explanation}\n`;
        }
      }
      if (p.exemplars.fail?.length) {
        block += `\nNon-compliant examples:\n`;
        for (const ex of p.exemplars.fail) {
          block += `- ${ex.scenario}: ${ex.explanation}\n`;
        }
      }
    }
    return block;
  }).join('\n---\n');

  const actionJson = JSON.stringify(context.action, null, 2);

  return `You are a governance compliance evaluator for advertising campaigns. Evaluate the following action against the applicable policies.

## Campaign plan
- Plan ID: ${context.plan.plan_id}
- Objectives: ${context.plan.objectives}
- Authorized countries: ${context.plan.countries.join(', ') || 'not specified'}
- Authorized regions: ${context.plan.regions.join(', ') || 'not specified'}
- Required channels: ${context.plan.channels_required.join(', ') || 'none'}
- Allowed channels: ${context.plan.channels_allowed.join(', ') || 'all'}

## Action being evaluated
- Binding: ${context.binding} (${context.binding === 'proposed' ? 'orchestrator checking before sending' : 'seller checking before executing'})
- Phase: ${context.phase}
${actionJson}

## Applicable policies
${policyBlocks}

## Instructions
Evaluate the action against each policy. For each policy violation or concern, produce a finding.

Respond with valid JSON only (no markdown):
{
  "findings": [
    {
      "category_id": "regulatory_compliance" or "brand_policy",
      "policy_id": "<the policy_id from above>",
      "severity": "info" | "warning" | "critical",
      "explanation": "<clear explanation of the finding>"
    }
  ],
  "explanation": "<1-2 sentence overall assessment>"
}

Severity guide:
- "critical": The action clearly violates a "must" enforcement policy. Block the action.
- "warning": The action may violate a "should" policy or is borderline. Allow but flag.
- "info": Advisory note for a "may" policy. Log only.

If no issues found, return empty findings array with a positive explanation.`;
}

/**
 * Evaluate an action against resolved policies using Claude.
 */
export async function evaluatePolicies(
  policyIds: string[],
  context: EvaluationContext
): Promise<PolicyEvaluation> {
  if (policyIds.length === 0) {
    return { findings: [], explanation: 'No policies to evaluate.' };
  }

  // Resolve policies from registry
  const resolved = await bulkResolve(policyIds);
  const policies = policyIds
    .map(id => resolved[id])
    .filter((p): p is Policy => p !== null);

  if (policies.length === 0) {
    return { findings: [], explanation: 'No matching policies found in registry.' };
  }

  const prompt = buildEvaluationPrompt(policies, context);

  try {
    const response = await anthropic.messages.create({
      model: ModelConfig.primary,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    // Parse JSON response
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.findings)) {
      logger.warn({ response: text.slice(0, 200) }, 'Policy evaluation returned non-array findings');
      return {
        findings: [{
          category_id: 'regulatory_compliance',
          severity: 'warning',
          explanation: 'Policy evaluation returned unexpected format. Manual review recommended.',
        }],
        explanation: 'Policy evaluation produced invalid output.',
      };
    }
    return {
      findings: parsed.findings.map((f: any) => ({
        category_id: f.category_id || 'regulatory_compliance',
        policy_id: f.policy_id,
        severity: f.severity || 'info',
        explanation: f.explanation || '',
      })),
      explanation: parsed.explanation || 'Policy evaluation complete.',
    };
  } catch (error) {
    logger.error({ error, policyCount: policies.length }, 'Policy evaluation failed');
    // Return a conservative finding on evaluation failure
    return {
      findings: [{
        category_id: 'regulatory_compliance',
        severity: 'warning',
        explanation: 'Policy evaluation service temporarily unavailable. Manual review recommended.',
      }],
      explanation: 'Policy evaluation could not be completed. Flagged for manual review.',
    };
  }
}

/**
 * Resolve which policies apply to a plan based on brand config, jurisdictions, and verticals.
 *
 * This is the "policy resolution" step described in the campaign governance spec.
 * Auto-applies policies that match the plan's jurisdictions and verticals.
 */
export async function resolvePoliciesForPlan(
  brandPolicyIds: string[],
  countries: string[],
  verticals: string[]
): Promise<Array<{ policy_id: string; source: 'explicit' | 'auto_applied'; enforcement: 'must' | 'should' | 'may'; reason?: string }>> {
  const result: Array<{ policy_id: string; source: 'explicit' | 'auto_applied'; enforcement: 'must' | 'should' | 'may'; reason?: string }> = [];

  // Resolve explicit policies from brand config
  if (brandPolicyIds.length > 0) {
    const resolved = await bulkResolve(brandPolicyIds);
    for (const id of brandPolicyIds) {
      const policy = resolved[id];
      if (policy) {
        result.push({
          policy_id: id,
          source: 'explicit',
          enforcement: policy.enforcement,
        });
      }
    }
  }

  // Auto-apply policies by jurisdiction match
  if (countries.length > 0) {
    const explicitIds = new Set(brandPolicyIds);

    for (const country of countries) {
      const { policies } = await listPolicies({ jurisdiction: country, limit: 100 });
      for (const policy of policies) {
        if (!explicitIds.has(policy.policy_id) && !result.some(r => r.policy_id === policy.policy_id)) {
          // Check vertical match if policy has vertical restrictions
          if (policy.verticals.length === 0 || verticals.some(v => policy.verticals.includes(v))) {
            result.push({
              policy_id: policy.policy_id,
              source: 'auto_applied',
              enforcement: policy.enforcement,
              reason: `Matched jurisdiction ${country}${policy.verticals.length > 0 ? ` and vertical ${policy.verticals.join(', ')}` : ''}`,
            });
          }
        }
      }
    }
  }

  return result;
}
