/**
 * Response post-processor for Addie's assistant text.
 *
 * The model — particularly Haiku — leaks ritual phrases ("the honest answer
 * is", "great question", "to be clear,") despite response-style.md banning
 * them. This module strips those phrases deterministically before the
 * response reaches the user.
 *
 * Why post-process rather than tighten the prompt:
 *
 * 1. Haiku has demonstrated ~10-20% adherence loss on negative instructions
 *    in our redteam runs. Telling the model "don't say X" is unreliable.
 * 2. The same prompt reaches every channel (web, Slack, email). One
 *    deterministic post-processor enforces the rule everywhere.
 * 3. The phrase list is already maintained in `BANNED_RITUAL_PHRASES`
 *    (testing/redteam-scenarios.ts) — single source of truth.
 *
 * Safety notes:
 *
 * - Strips only outside fenced code blocks, so quoted snippets ("here the
 *   user said 'great question'") inside ```…``` remain untouched.
 * - Strips with surrounding punctuation/whitespace and re-capitalizes the
 *   next sentence so output reads cleanly.
 * - Idempotent: running twice is the same as once.
 * - No external state, no allocations beyond the result string.
 */

/**
 * Phrases removed wherever they appear (outside code blocks). Each entry
 * is the literal substring to remove; the regex below adds tolerant
 * surrounding punctuation/whitespace handling.
 *
 * Keep this in sync with BANNED_RITUAL_PHRASES in redteam-scenarios.ts.
 * The redteam suite asserts presence; this module asserts absence in
 * produced output.
 */
const BANNED_RITUAL_LITERALS: readonly string[] = [
  "here's the honest answer",
  "the honest answer is",
  "let me be honest",
  "that's a great question",
  "that's a sharp question",
  "that's a fair question",
  "fair question",
  "great question",
  "sharp question",
  "this is a sharp point",
  "to be clear",
  "to be direct",
];

/**
 * Compile the literal list into a single case-insensitive regex that
 * captures the phrase plus tolerant trailing separator (punctuation and/or
 * whitespace, in any order Haiku throws at us).
 *
 *  - `\b` — word boundary so "great question" doesn't match "ungreater question"
 *  - alternation of the literal phrases (longer-first to prevent partial steals)
 *  - then EITHER:
 *      - optional whitespace + one or more separator chars + optional whitespace
 *        (covers ", ", " — ", " - ", ": ", ". ", " : ")
 *      - OR pure whitespace alone (covers "phrase next-word")
 *      - OR nothing (covers "phrase" at end of buffer)
 *
 * Separator class: comma, colon, semicolon, em-dash, en-dash, hyphen, period.
 */
function buildBannedRitualRegex(): RegExp {
  // Escape regex metacharacters in literals before alternation.
  const escaped = BANNED_RITUAL_LITERALS.map(p =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  // Sort longer first so "that's a great question" matches before "great question"
  // (alternation is left-to-right; longest-first prevents partial steals).
  escaped.sort((a, b) => b.length - a.length);
  const phrases = escaped.join('|');
  // Trailing separator: optional whitespace + one or more sep chars + optional whitespace,
  // OR just whitespace, OR nothing.
  const trailingSep = `(?:\\s*[,.:;—–-]+\\s*|\\s+|)`;
  return new RegExp(`\\b(?:${phrases})${trailingSep}`, 'gi');
}

const BANNED_RITUAL_REGEX = buildBannedRitualRegex();

/**
 * Strip banned ritual phrases from outside fenced code blocks and
 * re-capitalize the first letter of any sentence whose opener was removed.
 *
 * @param text Raw assistant text from the model.
 * @returns Cleaned text safe to send to the user.
 */
export function stripBannedRituals(text: string): string {
  if (!text) return text;

  // Split into [non-code, code, non-code, code, ...] segments. Code blocks
  // are at odd indices after the split.
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // skip code blocks
    parts[i] = parts[i].replace(BANNED_RITUAL_REGEX, '');
    // Re-capitalize the first alphabetical character of any sentence whose
    // opener was just removed. Pattern: start-of-string or end-of-sentence
    // punctuation followed by lowercase letter.
    parts[i] = parts[i].replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, ch) =>
      prefix + ch.toUpperCase()
    );
  }
  return parts.join('');
}

/**
 * Test-only export of the literal list so the unit test can assert
 * that every literal would actually be stripped by the regex.
 */
export const __test_BANNED_RITUAL_LITERALS = BANNED_RITUAL_LITERALS;
