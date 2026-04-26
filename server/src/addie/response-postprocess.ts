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

// ---------------------------------------------------------------------------
// Length post-processor: trim verbose responses to short questions
// ---------------------------------------------------------------------------

/**
 * Word-count thresholds for the length post-processor.
 *
 * Sonnet's instinct toward thoroughness produces 250–350-word answers to
 * 7–12-word challenges even with response-style.md teaching it to match
 * the conversational register. Direct redteam confirmation across
 * priv-1 / acct-1 / acct-2 / gap-1: the rule reduces mean length but
 * doesn't enforce a ceiling. This module is the deterministic floor.
 *
 * Why these numbers:
 * - 15-word user question: empirically the line where conversational
 *   yes/no challenges and short open questions sit. Above this the
 *   user is asking for something multi-part and length is justified.
 * - 160-word response cap: matches the existing redteam shortQuestion
 *   length_cap check, so the post-processor enforces what the suite
 *   measures.
 * - 130-word truncation target: leaves a buffer below the 160 cap so
 *   the truncated form (plus the "go deeper?" suffix) lands well under.
 */
const SHORT_QUESTION_MAX_WORDS = 15;
const RESPONSE_CAP_WORDS = 160;
const TRUNCATION_TARGET_WORDS = 130;

const TRUNCATION_SUFFIX = '\n\n*Happy to go deeper on any of this if useful.*';

/** Count words in a string by whitespace splits, ignoring empty tokens. */
function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * If the question is short and the response runs long, truncate the response
 * at the sentence boundary nearest TRUNCATION_TARGET_WORDS and append a
 * "go deeper?" suffix. Otherwise return the response unchanged.
 *
 * Truncation behavior:
 *
 * - Splits the response into chunks alternating between [prose, code-fence,
 *   prose, code-fence, ...]. Code fences are kept whole — never cut inside
 *   ```fenced``` content; if including a fence would push us over the
 *   target, we stop before the fence rather than mid-block.
 * - For prose chunks, splits on sentence terminators (.!?) followed by
 *   whitespace. Accumulates sentences until adding the next one would
 *   exceed TRUNCATION_TARGET_WORDS, then stops.
 * - If even the first sentence of the response already exceeds the target,
 *   we keep that one sentence rather than returning empty — a single long
 *   sentence is still better than no answer.
 *
 * Idempotent: running on already-truncated text leaves it unchanged
 * (the truncated form is below the response cap by construction).
 *
 * @param question The user's most recent message text.
 * @param text The assistant's response text (post-strip).
 * @returns The original text, or a truncated form with a "go deeper?" suffix.
 */
export function truncateLongResponseToShortQuestion(
  question: string,
  text: string,
): string {
  if (!question || !text) return text;
  const questionWords = countWords(question);
  if (questionWords > SHORT_QUESTION_MAX_WORDS) return text;
  const responseWords = countWords(text);
  if (responseWords <= RESPONSE_CAP_WORDS) return text;

  // Split on fenced code blocks so we never truncate inside one.
  const parts = text.split(/(```[\s\S]*?```)/g);

  let cumulativeWords = 0;
  const kept: string[] = [];
  let stopped = false;

  for (let i = 0; i < parts.length && !stopped; i++) {
    const part = parts[i];
    const isCode = i % 2 === 1;

    if (isCode) {
      const blockWords = countWords(part);
      if (kept.length === 0 || cumulativeWords + blockWords <= TRUNCATION_TARGET_WORDS) {
        kept.push(part);
        cumulativeWords += blockWords;
      } else {
        // Including this fence would push us over — stop before it.
        stopped = true;
      }
      continue;
    }

    // Prose segment. Split into sentences and add until we hit the target.
    const sentences = splitProseIntoSentences(part);
    const proseKept: string[] = [];
    for (const sentence of sentences) {
      const w = countWords(sentence);
      if (kept.length === 0 && proseKept.length === 0) {
        // Always keep the first sentence even if it's already over budget —
        // a one-sentence answer beats no answer.
        proseKept.push(sentence);
        cumulativeWords += w;
        continue;
      }
      if (cumulativeWords + w > TRUNCATION_TARGET_WORDS) {
        stopped = true;
        break;
      }
      proseKept.push(sentence);
      cumulativeWords += w;
    }
    if (proseKept.length > 0) {
      kept.push(proseKept.join(' '));
    }
  }

  const truncated = kept.join('').trimEnd();
  return truncated + TRUNCATION_SUFFIX;
}

/**
 * Split prose into sentences, preserving original whitespace separators
 * so the rejoined output reads naturally.
 *
 * Splits on `[.!?]` followed by whitespace, but keeps the terminator with
 * the preceding sentence so reassembly is just `.join(' ')`.
 */
function splitProseIntoSentences(prose: string): string[] {
  if (!prose) return [];
  // Match: text up to and including a sentence terminator + trailing whitespace.
  // Final segment may not end in a terminator; capture it separately.
  const matches = prose.match(/[^.!?]+[.!?]+\s*/g) || [];
  const consumed = matches.join('');
  const trailing = prose.slice(consumed.length).trim();
  const out = matches.map(s => s.trim()).filter(Boolean);
  if (trailing) out.push(trailing);
  return out;
}

/** Test-only exports for the unit test. */
export const __test_lengthThresholds = {
  SHORT_QUESTION_MAX_WORDS,
  RESPONSE_CAP_WORDS,
  TRUNCATION_TARGET_WORDS,
  TRUNCATION_SUFFIX,
};
