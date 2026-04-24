#!/usr/bin/env node
/**
 * Lint `.agents/current-context.md`.
 *
 * This file is loaded verbatim into Addie's system prompt (via the rules
 * loader in `server/src/addie/rules/index.ts`) on every conversational
 * turn. That makes its contents a high-value target for prompt injection
 * and a persistent surface for off-brand or internal-sounding content.
 *
 * Two layers:
 *   - **Safety** (hard fail): file size cap, level-1 heading ban,
 *     injection-marker regexes, control-character check. The runtime
 *     loader already defends (fence, heading demotion, size cap), but
 *     failing CI when something slips in keeps the file clean at the
 *     source rather than relying on defense-in-depth.
 *   - **Boundary** (warning): phrases that suggest the content belongs
 *     in `.agents/internal-context.md` instead — "tier-1 gap", named
 *     stakeholder attribution, "narrative", "editorial", etc. These
 *     don't break anything technically, but they're the signaling the
 *     product review flagged as "reads weird to a cold prospect."
 *
 * Designed to also run locally during context-refresh: the routine
 * invokes this after rewriting the file and before opening a PR.
 */
import { readFileSync, existsSync } from 'node:fs';

const PATH = '.agents/current-context.md';
const MAX_BYTES = 16 * 1024;

if (!existsSync(PATH)) {
  console.error(`✗ ${PATH} does not exist.`);
  process.exit(1);
}

const content = readFileSync(PATH, 'utf-8');
const lines = content.split('\n');
const errors = [];
const warnings = [];

// -- Safety checks (hard fail) -----------------------------------------

if (content.length > MAX_BYTES) {
  errors.push(
    `File exceeds ${MAX_BYTES} bytes (${content.length}). The runtime ` +
    `loader will truncate — trim or move sections to internal-context.md.`
  );
}

// Level-1 ATX headings get demoted by the runtime loader, but failing
// here tells authors to use `##` instead of relying on silent rewrite.
lines.forEach((line, i) => {
  if (/^#\s/.test(line)) {
    errors.push(
      `Line ${i + 1}: level-1 heading. Use \`## \` instead — the runtime ` +
      `demotes these to prevent prompt-section spoofing.`
    );
  }
});

// Injection-marker regexes. These patterns appear often in real prompt-
// injection payloads and have no place in a factual status snapshot.
const INJECTION_PATTERNS = [
  [/ignore\s+(?:previous|prior|above|all)/i, 'ignore-previous'],
  [/^(?:system|assistant|user)\s*:/im, 'role-marker'],
  [/you\s+(?:are|must|should|will)\s+now/i, 'behavior-switch'],
  [/new\s+instructions?\s*:/i, 'new-instructions'],
  [/\bdisregard\b/i, 'disregard'],
  [/<\/?(?:system|instructions?|prompt|context|addie_reference)>/i, 'fence-tag'],
];
for (const [re, label] of INJECTION_PATTERNS) {
  const m = content.match(re);
  if (m) {
    errors.push(
      `Injection marker "${m[0]}" (${label}). This file is read into ` +
      `Addie's system prompt; imperatives directed at the model are banned.`
    );
  }
}

// Control characters (strip TAB / LF / CR from the check).
if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content)) {
  errors.push('Control characters present. Strip them.');
}

// -- Boundary checks ---------------------------------------------------

// Hard fail: boundary framing inside a **bold** span — bullet labels
// and section emphasis are the load-bearing signal. "Compliance
// storyboard gaps" as a bullet label reads like internal framing;
// "filter-behaviour gap [#2902]" mid-sentence is describing a linked
// issue and is fine.
// "tier-N" and "editorial" are deliberately omitted — AdCP has
// legitimate product concepts using both (e.g. "Tier-2 Production
// Verified", "Member editorial workflow"). They stay as
// BOUNDARY_PATTERNS warnings for subtler cases.
const LABEL_BAN = /\*\*[^*\n]*\b(?:gap|risk|concern|narrative|stakeholder)s?\b[^*\n]*\*\*/i;
const labelMatch = content.match(LABEL_BAN);
if (labelMatch) {
  errors.push(
    `Boundary framing inside a bold span: "${labelMatch[0]}". Bullet ` +
    `labels and section emphasis should be factual nouns. Reword ` +
    `(e.g. "gaps" → "remediation") or move the entry to ` +
    `\`.agents/internal-context.md\`.`
  );
}

const BOUNDARY_PATTERNS = [
  [/\btier[- ][0-9]\b/i, 'priority tier ("tier-1")'],
  [/\b(?:narrative|editorial)\b/i, 'editorial framing'],
  [/\bgap\b/i, '"gap" framing'],
  [/\bblocked\s+on\s+(?!PR\b|#)/i, 'blocker attribution (not a PR link)'],
  [/\b(?:Brian|bokelley)\s+(?:flagged|thinks|believes|said|wants)\b/i,
    'stakeholder attribution to a named person'],
];
for (const [re, label] of BOUNDARY_PATTERNS) {
  if (re.test(content)) {
    warnings.push(
      `${label}: consider moving to \`.agents/internal-context.md\`. ` +
      `The public snapshot is exposed to any community member via Addie.`
    );
  }
}

// -- Report ------------------------------------------------------------

if (errors.length) {
  console.error(`✗ ${PATH} — ${errors.length} safety error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
}
if (warnings.length) {
  console.error(`⚠ ${PATH} — ${warnings.length} boundary warning(s):`);
  for (const w of warnings) console.error(`  - ${w}`);
}

if (errors.length) {
  console.error('\nFix errors above. Warnings do not fail the build.');
  process.exit(1);
}
if (warnings.length) {
  console.log('\n(warnings noted — consider addressing, but build passes)');
}
console.log(`✓ ${PATH} passes safety checks`);
