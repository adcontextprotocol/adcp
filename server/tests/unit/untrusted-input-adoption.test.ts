import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * CI guardrail for #2797.
 *
 * Any file in `server/src/` that references `<untrusted_proposer_input>`
 * (either as a boundary tag in output, or in logic that decides how to
 * treat proposer content) MUST import from `./untrusted-input.js` so
 * the neutralization helpers get used consistently. Without this test,
 * the next author can reinvent the inline neutralize closure that
 * #2794 just consolidated — re-opening the tag-escape bypass the
 * helper defends against.
 *
 * Exceptions:
 * - `untrusted-input.ts` itself is the canonical module, no import needed.
 * - `prompts.ts` references the tag in system-prompt text (it tells
 *   Sonnet what the boundary is). That's the consumer side, not the
 *   producer side — no helper import required, but flagged in the
 *   allowlist so a future change in prompts.ts gets re-reviewed.
 *
 * If this test fails, the fix is almost always:
 *   import { wrapUntrustedInput, neutralizeAndTruncate } from './untrusted-input.js';
 *
 * …and use those helpers instead of hand-rolling `<untrusted_proposer_input>` strings.
 */

const SOURCE_ROOT = path.resolve(__dirname, '../../src');
const HELPER_MODULE = 'untrusted-input.ts';
const ALLOWED_TAG_REFERENCES = new Set([
  // Canonical module — defines the helpers, must reference the tag.
  'addie/mcp/untrusted-input.ts',
  // System prompt — tells Sonnet to treat the tag as a boundary.
  // Safe because it's one-way consumer-side knowledge that ships to
  // the LLM, not logic that emits proposer content.
  'addie/prompts.ts',
]);

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function relativeToSource(file: string): string {
  return path.relative(SOURCE_ROOT, file).split(path.sep).join('/');
}

describe('untrusted-input helper adoption (#2797)', () => {
  it('any file referencing <untrusted_proposer_input> imports from the helper module', () => {
    const files = walkSourceFiles(SOURCE_ROOT);
    const violations: Array<{ file: string; reason: string }> = [];

    for (const file of files) {
      const rel = relativeToSource(file);
      const contents = fs.readFileSync(file, 'utf8');

      // The tag literal (open or close, case-insensitive) is the
      // anchor — every file that writes this tag must route through
      // the helper's neutralization.
      if (!/<\s*\/?\s*untrusted_proposer_input\b/i.test(contents)) continue;

      if (ALLOWED_TAG_REFERENCES.has(rel)) continue;

      // Consumer file: must import at least one of the helper exports.
      const hasHelperImport = /from\s+['"][./]*(?:mcp\/)?untrusted-input(?:\.js)?['"]/.test(contents);
      if (!hasHelperImport) {
        violations.push({
          file: rel,
          reason: 'References <untrusted_proposer_input> tag but does not import from untrusted-input',
        });
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(v => `  - ${v.file}: ${v.reason}`)
        .join('\n');
      throw new Error(
        `untrusted-input helper adoption failed:\n${msg}\n\n` +
        `Fix: import { wrapUntrustedInput, neutralizeAndTruncate } ` +
        `from './untrusted-input.js' and use those helpers ` +
        `instead of raw tag strings. See server/src/addie/mcp/untrusted-input.ts.`
      );
    }

    // Sanity: the canonical module should exist
    expect(fs.existsSync(path.join(SOURCE_ROOT, 'addie/mcp/', HELPER_MODULE))).toBe(true);
  });
});
