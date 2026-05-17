/**
 * Tests for the NOT COMPLETED sentinel used by complete_certification_module
 * and complete_certification_exam gate-failure responses.
 *
 * The sentinel is what the `addie/rules/constraints.md` rule pattern-matches
 * on to stop Sage from announcing module completion after a rejected tool
 * call. If this format changes, the rule must change with it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  NOT_COMPLETED_SENTINEL,
  MODULE_COMPLETED_PREFIX,
  CAPSTONE_COMPLETED_PREFIX,
  notCompleted,
  type CompletionGateClass,
} from '../../src/addie/mcp/certification-tools.js';

describe('NOT COMPLETED sentinel', () => {
  it('exposes the sentinel string the Sage rule keys on', () => {
    expect(NOT_COMPLETED_SENTINEL).toBe('NOT COMPLETED');
  });

  it('exposes the success-line prefixes the Sage rule keys on', () => {
    // These two strings are quoted verbatim in `addie/rules/constraints.md`.
    // Renaming requires editing the rule in the same PR.
    expect(MODULE_COMPLETED_PREFIX).toBe('Module {ID} completed!');
    expect(CAPSTONE_COMPLETED_PREFIX).toBe('# Congratulations! The learner passed the capstone!');
  });

  it('begins the response with the sentinel so Sage can pattern-match it', () => {
    const out = notCompleted('B2', 'time', 'Module was started less than 5 minutes ago.');
    expect(out.startsWith(NOT_COMPLETED_SENTINEL + ' ')).toBe(true);
  });

  it('names the specific module so the rejection is unambiguous', () => {
    const out = notCompleted('B2', 'score', 'Score inconsistency detected.');
    expect(out).toContain('module B2');
  });

  it('includes the rejection reason verbatim', () => {
    const reason = 'You must save at least one teaching checkpoint before completing a module.';
    const out = notCompleted('S1', 'evidence', reason);
    expect(out).toContain(reason);
  });

  it('includes an explicit instruction not to claim completion', () => {
    const out = notCompleted('B2', 'time', 'Anything.');
    expect(out.toLowerCase()).toContain('do not tell the learner');
  });

  it('does not start with either success-line prefix that Sage rules treat as success', () => {
    // If the rejection collided with a success prefix, the constraints.md
    // rule would misclassify the response. Guard both.
    const out = notCompleted('B2', 'time', 'Some reason.');
    expect(out.startsWith('Module B2 completed!')).toBe(false);
    expect(out.startsWith(CAPSTONE_COMPLETED_PREFIX)).toBe(false);
  });

  it('emits a learner-facing reframe distinct for each gate class', () => {
    const gateClasses: CompletionGateClass[] = ['time', 'evidence', 'state', 'score'];
    const reframes = new Set(gateClasses.map(g => notCompleted('X', g, 'r')));
    // Each gate class produces a distinct response — proves the framing
    // dispatch isn't accidentally collapsing categories together.
    expect(reframes.size).toBe(gateClasses.length);
  });

  it('forbids "mastered" / "locked in" / "in the books" synonyms in the rule directive', () => {
    // The forbidden-phrasing list is what stops Sage from routing around
    // "complete" by reaching for a synonym (#4647). Without these phrases
    // in the directive the LLM has license to rationalize.
    const out = notCompleted('B2', 'time', 'r');
    expect(out).toContain('mastered');
    expect(out).toContain('locked in');
    expect(out).toContain('in the books');
  });
});

describe('completion-gate static guard', () => {
  // Read the source as text and assert that every completion-gate rejection
  // in the two completion handlers routes through `notCompleted(...)`. The
  // failure mode this guards against: a future contributor adds a new gate
  // and forgets the wrapper, so Sage's rule never trips.
  const source = readFileSync(
    resolve(__dirname, '../../src/addie/mcp/certification-tools.ts'),
    'utf8',
  );

  function bodyBetween(start: RegExp, end: RegExp): string {
    const startIdx = source.search(start);
    if (startIdx === -1) throw new Error(`Marker not found: ${start}`);
    const tail = source.slice(startIdx);
    const endRel = tail.search(end);
    if (endRel === -1) throw new Error(`End marker not found after ${start}`);
    return tail.slice(0, endRel);
  }

  function rejectionReturnsNotWrapped(body: string): string[] {
    // Match any `return '...'` or `return \`...\`` line in the handler body.
    // Filter to plausible "rejection-shaped" strings (mentioning module,
    // checkpoint, score, scores, exam, attempt, threshold). If we find one
    // that does not go through notCompleted, fail.
    const matches: string[] = [];
    const literalRegex = /return\s+(['"`])([^'"`\n]{20,})\1\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = literalRegex.exec(body)) !== null) {
      const text = m[2];
      if (/module|module_id|checkpoint|score|scores|exam|attempt|threshold|demonstration/i.test(text)) {
        matches.push(text);
      }
    }
    return matches;
  }

  it('every rejection-shaped return in complete_certification_module goes through notCompleted', () => {
    const body = bodyBetween(/handlers\.set\('complete_certification_module'/, /handlers\.set\(/);
    const offenders = rejectionReturnsNotWrapped(body);
    expect(offenders).toEqual([]);
  });

  it('every rejection-shaped return in complete_certification_exam goes through notCompleted', () => {
    const body = bodyBetween(/handlers\.set\('complete_certification_exam'/, /handlers\.set\(/);
    const offenders = rejectionReturnsNotWrapped(body);
    expect(offenders).toEqual([]);
  });
});
