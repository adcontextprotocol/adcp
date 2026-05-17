/**
 * Tests for the NOT COMPLETED sentinel used by complete_certification_module
 * and complete_certification_exam gate-failure responses.
 *
 * The sentinel is what the `addie/rules/constraints.md` rule pattern-matches
 * on to stop Sage from announcing module completion after a rejected tool
 * call. If this format changes, the rule must change with it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
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
    // Advance past the start marker itself; otherwise `end` (which also
    // matches `handlers.set(`) would match the start marker at offset 0
    // and the body would be empty (see PR #4665 review).
    const endRel = tail.slice(1).search(end);
    if (endRel === -1) throw new Error(`End marker not found after ${start}`);
    return tail.slice(0, endRel + 1);
  }

  // Strings that are arg-validation errors, not completion-gate rejections.
  // These appear at the top of the handler before any teaching state is read
  // and don't need the NOT COMPLETED sentinel — they're about invalid input,
  // not about a learner being mid-flight. Match by substring so minor wording
  // tweaks don't break the allowlist.
  const ARG_VALIDATION_ALLOWLIST: RegExp[] = [
    /attempt_id and scores are required/,
    /Scores are required to complete a module/,
    /Exam attempt not found/,
    /This exam attempt belongs to a different user/,
    /This exam attempt is already completed/,
    /Invalid attempt_id/,
    /capstone module not found for this exam attempt/,
  ];

  function rejectionReturnsNotWrapped(body: string): string[] {
    // Match any `return '...'`, `return "..."`, or `return \`...\`` literal —
    // including multi-line backtick template literals — in the handler body.
    // `[\s\S]` matches across newlines so a future contributor cannot slip a
    // multi-line rejection past the guard by spreading the string over lines.
    //
    // Caveat: non-greedy `{20,}?` paired with `\1` could in principle span
    // two adjacent same-quote `return` statements. Today's source doesn't
    // trigger this; if a future false positive appears, tighten the inner
    // class to forbid `\1` re-occurrence rather than relying on non-greedy.
    //
    // Filter to plausible "rejection-shaped" strings (mentioning module,
    // checkpoint, score, scores, exam, attempt, threshold, demonstration).
    // Arg-validation strings (allowlist above) are excluded — they're not
    // gate rejections.
    const matches: string[] = [];
    const literalRegex = /return\s+(['"`])([\s\S]{20,}?)\1\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = literalRegex.exec(body)) !== null) {
      const text = m[2];
      if (!/module|module_id|checkpoint|score|scores|exam|attempt|threshold|demonstration/i.test(text)) continue;
      if (ARG_VALIDATION_ALLOWLIST.some(p => p.test(text))) continue;
      matches.push(text);
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

  it('only certification-tools.ts emits the success-line prefixes (#4660)', () => {
    // Sage's rule treats two literal strings as the only signal that a
    // module is recorded as complete. If any other handler in the MCP
    // catalog can emit either prefix (e.g. a debug/inspect tool that
    // echoes prior completions), Sage's rule provides no defense. Pin
    // the contract: only `certification-tools.ts` may emit these strings.
    //
    // Scope is `server/src/addie/mcp/`. If a future job/script outside the
    // MCP catalog ever produces output that flows into Sage's tool result
    // stream, widen the scan to cover it.
    //
    // Prefix regex assumes single-letter track + numeric module id
    // (A1, B2, S1, A2B). If module IDs grow to multi-letter prefixes,
    // extend the pattern here.
    const mcpDir = resolve(__dirname, '../../src/addie/mcp');
    const files = readdirSync(mcpDir).filter(f => f.endsWith('.ts'));
    const prefixRegex = /Module \$\{[A-Za-z_][A-Za-z0-9_]*\} completed!|Module [A-Z][0-9]+[A-Z]? completed!|# Congratulations! The learner passed the capstone!/;
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
      if (f === 'certification-tools.ts') continue;
      const src = readFileSync(join(mcpDir, f), 'utf8');
      src.split('\n').forEach((line, i) => {
        const m = line.match(prefixRegex);
        if (m) offenders.push({ file: f, line: i + 1, text: m[0] });
      });
    }
    expect(offenders).toEqual([]);
  });

  it('catches multi-line backtick rejections (regression for #4659)', () => {
    // Synthesise a hypothetical handler body with a multi-line rejection
    // return that the old [^'"`\n] regex would miss. The guard must catch it.
    const synthetic = "handlers.set('complete_certification_module', async () => {\n" +
      "  return `Module B2 is not completed yet —\n" +
      "  the checkpoint is missing.`;\n" +
      "});\nhandlers.set('next', async () => {});";
    const startIdx = synthetic.search(/handlers\.set\('complete_certification_module'/);
    const tail = synthetic.slice(startIdx);
    const endRel = tail.slice(1).search(/handlers\.set\(/);
    const body = tail.slice(0, endRel + 1);
    const offenders = rejectionReturnsNotWrapped(body);
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain('Module B2 is not completed yet');
  });
});
