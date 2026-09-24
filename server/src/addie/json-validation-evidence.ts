import { createHash } from 'node:crypto';
import { sideEffectReplayKey } from './side-effect-claims.js';
import type { ToolExecution } from './model-providers/tool-orchestration.js';

export const UNCONFIRMED_JSON_VALIDATION = 'I have not confirmed that the displayed JSON passes validation against the claimed schema. Treat it as an unvalidated candidate.';
export const REPEATED_JSON_VALIDATION = 'This identical candidate and schema already failed validation in this turn. Change the candidate or schema before calling validate_json again; repeating the same input cannot establish success.';

function candidateKey(value: unknown): string {
  return createHash('sha256').update(sideEffectReplayKey('validate_json', value)).digest('hex');
}

/** Only the anchored application-owned validate_json result is evidence. */
export function jsonValidationReceipt(execution: Pick<ToolExecution, 'tool_name' | 'parameters' | 'result' | 'is_error'>): {
  valid: boolean; schemaUrl: string; candidateKey: string;
} | null {
  if (execution.tool_name !== 'validate_json') return null;
  const firstLine = execution.result.split('\n', 1)[0] ?? '';
  const success = /^✅ \*\*Valid!\*\* The JSON validates successfully against (https:\/\/adcontextprotocol\.org\/schemas\/[^\s]+)$/.exec(firstLine);
  const failure = /^❌ \*\*Invalid\.\*\* Validation errors against (https:\/\/adcontextprotocol\.org\/schemas\/[^\s]+):$/.exec(firstLine);
  if ((!success && !failure) || (success && execution.is_error)) return null;
  // Legacy transport/compiler failures used the invalid-payload heading too.
  if (failure && execution.result.includes('Schema validation failed:')) return null;
  const json = execution.parameters.json;
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return { valid: Boolean(success), schemaUrl: (success ?? failure)![1]!, candidateKey: candidateKey(json) };
}

function claimsValidation(text: string, validationContext: boolean): boolean {
  const plain = text.replace(/[*_`]/g, '').replace(/[’‘]/g, "'");
  return plain.split(/[,;]|\b(?:but|and)\b/i).some(clause => {
    if (!/\b(?:JSON|payload|candidate|example|schema)\b/i.test(clause)
      && !/^\s*Validated against\b/i.test(clause)
      && !(validationContext && /^\s*Validation\b/i.test(clause))) return false;
    if (/^\s*(?:if|when|once|until|before|to)\b/i.test(clause) || clause.trimEnd().endsWith('?')) return false;
    const predicates = /\b(?:validat(?:ed|es)|schema[- ]validated|(?:passed|passes)\s+(?:all\s+)?(?:schema\s+)?(?:validation|checks)|conforms?\s+to|valid|succeeded|successful)\b/gi;
    for (const predicate of clause.matchAll(predicates)) {
      const prefix = clause.slice(0, predicate.index);
      if (/\b(?:not|never|haven't|hasn't|isn't|wasn't|cannot|can't|couldn't|unable to)(?:\s+\w+){0,3}\s+$/i.test(prefix)) continue;
      if (predicate[0].toLowerCase() === 'valid' && !/\b(?:is|was|are|were)\s+(?:(?:now|fully)\s+)?$/i.test(prefix)) continue;
      if (predicate[0].toLowerCase() === 'validates' && !/\b(?:JSON|payload|candidate|example)\s+(?:successfully\s+)?$/i.test(prefix)) continue;
      return true;
    }
    return false;
  });
}

/**
 * Fail closed on ambiguous candidates. Every displayed JSON object must have
 * same-turn successful evidence, and any schema/version named in the claim
 * must match that evidence. Code and payload strings are never claim prose.
 */
export function enforceJsonValidationClaims(text: string, executions: readonly ToolExecution[]): {
  text: string; reason: string | null;
} {
  const receipts = executions.map(jsonValidationReceipt).filter(receipt => receipt?.valid === true);
  const parts = text.split(/(```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~)/g);
  const candidates: unknown[] = [];
  let malformedCandidate = false;
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i]!;
    const fenced = /^(?:```|~~~)([^\n]*)\n([\s\S]*?)(?:```|~~~)$/.exec(block);
    if (fenced && !/^(?:json|jsonc)?\s*$/i.test(fenced[1]!)) continue;
    const source = fenced ? fenced[2]!.trim() : '';
    if (!source.startsWith('{') && !source.startsWith('[')) continue;
    try { candidates.push(JSON.parse(source)); } catch { malformedCandidate = true; }
  }
  // Keep inline schema/version formatting in the surrounding claim, but treat
  // inline JSON as payload data (including strings that resemble claims).
  for (let i = 0; i < parts.length; i += 2) {
    for (const match of parts[i]!.matchAll(/`(\{[^`\n]*\})`/g)) {
      try { candidates.push(JSON.parse(match[1]!)); } catch { malformedCandidate = true; }
    }
  }
  const matching = candidates.map(candidate => receipts.filter(receipt => receipt!.candidateKey === candidateKey(candidate)));
  const validationContext = candidates.length > 0 || executions.some(execution => execution.tool_name === 'validate_json');
  let replaced = false;
  let rendered = false;
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!.split(/((?<=[.!?])\s+|\n+)/).map(part => {
      const prose = part.replace(/`\{[^`\n]*\}`/g, '').replace(/[`*_]/g, '');
      if (!claimsValidation(prose, validationContext)) return part;
      const inlineCandidates = part.match(/`\{[^`\n]*\}`/g) ?? [];
      const preservedCandidates = inlineCandidates.length ? `\n\n${inlineCandidates.join('\n\n')}` : '';
      const urls = prose.match(/https?:\/\/[^\s)<>]+\/schemas\/[^\s)<>]+/g) ?? [];
      const withoutUrls = prose.replace(/https?:\/\/[^\s)<>]+/g, '');
      const paths = withoutUrls.match(/\b(?:[\w-]+\/)+[\w.-]+\.json\b/g) ?? [];
      const versions = prose.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/g) ?? [];
      const schemasMatch = (url: string) => urls.every(claim => url === claim.replace(/[.,!]$/, ''))
        && paths.every(path => url.endsWith(`/${path}`))
        && versions.every(version => url.includes(`/schemas/${version}/`));
      const confirmed = !malformedCandidate && matching.length > 0
        && matching.every(matches => matches.some(receipt => schemasMatch(receipt!.schemaUrl)));
      if (!confirmed) {
        replaced = true;
        return UNCONFIRMED_JSON_VALIDATION + preservedCandidates;
      }
      if (rendered) return preservedCandidates;
      rendered = true;
      const schemas = [...new Set(matching.flatMap(matches => matches
        .filter(receipt => schemasMatch(receipt!.schemaUrl)).map(receipt => receipt!.schemaUrl)))];
      return `The displayed JSON passed validation against ${schemas.join(', ')}.${preservedCandidates}`;
    }).join('');
  }
  return { text: parts.join(''), reason: replaced ? 'Unconfirmed JSON schema validation' : null };
}
