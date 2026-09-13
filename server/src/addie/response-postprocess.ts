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
  "good question",
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
 * Canonical list of banned ritual literals. Exported so the shape grader
 * (and tests) can assert against the same source of truth that the strip
 * regex is built from. Treat this as a public read-only export.
 */
export const BANNED_RITUALS = BANNED_RITUAL_LITERALS;

/** @deprecated use {@link BANNED_RITUALS}; kept for the existing unit test import. */
export const __test_BANNED_RITUAL_LITERALS = BANNED_RITUAL_LITERALS;

// ---------------------------------------------------------------------------
// Persona-collapse backstop: scrub model/provider self-disclosure
// ---------------------------------------------------------------------------

/**
 * Patterns that signal Addie has broken character and disclosed the underlying
 * model or vendor ("I'm Claude, an AI assistant made by Anthropic", "as a
 * large language model …"). Under task-stress — a tool failure, a validation
 * error, a capability it can't fulfil — the model can rationalize around the
 * prompt-level identity rule and step out of persona. `rules/identity.md`
 * is the probabilistic defense; this is the deterministic one.
 *
 * Each regex is matched against a single sentence (see `rewritePersonaCollapse`)
 * so a match removes only the offending sentence, not the whole reply.
 *
 * Precision over recall on the model name: the bare word "Claude" is NOT a
 * disclosure — Addie legitimately references "Claude Code" and "Claude Desktop"
 * as MCP clients in its docs. The patterns anchor on first-person identity
 * constructions ("I'm Claude", "Claude, an AI …", "powered by Claude") and on
 * vendor attribution ("made by Anthropic"), never on the product names.
 */
export const PERSONA_COLLAPSE_PATTERNS: readonly RegExp[] = [
  // First-person disclosure naming the model.
  /\bi(?:['’]m|\s+am)\s+claude\b/i,
  // "Claude, an AI assistant / a language model / the AI …"
  /\bclaude\s*[,:]\s*(?:an?|the)\s+(?:ai\b|a\.i\.|artificial\s+intelligence|language\s+model|(?:ai\s+)?(?:assistant|chatbot|model))/i,
  // Vendor attribution.
  /\b(?:made|built|created|developed|trained|designed)\s+by\s+(?:anthropic|openai|google\s+deepmind)\b/i,
  /\bpowered\s+by\s+(?:claude|anthropic|gpt-?\d*|openai)\b/i,
  // First-person AI/model statement that also names the vendor in-sentence.
  /\bi(?:['’]m|\s+am)\s+(?:an?\s+)?(?:ai|a\.i\.|artificial\s+intelligence|language)\b[^.?!]*\b(?:anthropic|openai)\b/i,
  // Generic LLM self-reference used to step out of persona. Requires an
  // AI/language qualifier so a bare "serves as a model for X" doesn't match.
  /\bas\s+an?\s+(?:(?:ai|artificial\s+intelligence)\s+(?:language\s+)?model|language\s+model|llm)\b/i,
  /\b(?:a\s+)?large\s+language\s+model\b/i,
  /\bmy\s+underlying\s+(?:model|llm|language\s+model|architecture)\b/i,
];

/** True if any persona-collapse pattern matches the given text. */
export function hasPersonaCollapse(text: string): boolean {
  return PERSONA_COLLAPSE_PATTERNS.some((re) => re.test(text));
}

/**
 * Remove any sentence that discloses the underlying model or vendor, leaving
 * the rest of the reply intact. If every sentence was a disclosure the result
 * is empty — the pipeline's empty-response guard then substitutes a fallback.
 *
 * Safety notes mirror `stripBannedRituals`:
 *  - Scans and rewrites only outside fenced code blocks, so a disclosure quoted
 *    inside ```…``` (e.g. documenting this very leak) is preserved.
 *  - Idempotent: a scrubbed reply has no remaining matches, so a second pass
 *    is a no-op.
 *  - Fast path: if no disclosure appears outside code, the input is returned
 *    byte-for-byte unchanged.
 *
 * @param text Raw assistant text from the model.
 * @returns Text with model/provider self-disclosure sentences removed.
 */
export function rewritePersonaCollapse(text: string): string {
  if (!text) return text;

  // Split into [non-code, code, non-code, ...]; code blocks are odd indices.
  const parts = text.split(/(```[\s\S]*?```)/g);

  let matchOutsideCode = false;
  for (let i = 0; i < parts.length; i += 2) {
    if (hasPersonaCollapse(parts[i])) {
      matchOutsideCode = true;
      break;
    }
  }
  if (!matchOutsideCode) return text;

  for (let i = 0; i < parts.length; i += 2) {
    const sentences = splitProseIntoSentences(parts[i]);
    parts[i] = sentences.filter((s) => !hasPersonaCollapse(s)).join('');
  }

  // Collapse whitespace left where sentences were removed.
  return parts
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Test-only export of the persona-collapse pattern list. */
export const __test_PERSONA_COLLAPSE_PATTERNS = PERSONA_COLLAPSE_PATTERNS;

/** Preserve punctuation and whitespace when removing persona disclosures. */
function splitProseIntoSentences(prose: string): string[] {
  if (!prose) return [];
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < prose.length; index++) {
    if (!'.!?'.includes(prose[index])) continue;
    let end = index + 1;
    if (end < prose.length && !/\s/.test(prose[end])) continue;
    while (end < prose.length && /\s/.test(prose[end])) end++;
    segments.push(prose.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < prose.length) segments.push(prose.slice(start));
  return segments;
}

// ---------------------------------------------------------------------------
// Combined response pipeline
// ---------------------------------------------------------------------------

/**
 * Fallback shown when the model returns an empty assistant message. Two
 * redteam-flagged turns produced rating=1 "Response is empty" responses on
 * short follow-up prompts ("?", "what happened?"). Substituting a clarifying
 * line is better than shipping the void.
 */
export const EMPTY_RESPONSE_FALLBACK =
  "Sorry, I lost the thread there. Could you rephrase or give me a bit more context?";

/**
 * Apply the full assistant-text post-processing chain in order:
 *
 * 1. `rewritePersonaCollapse` — scrub any sentence that discloses the
 *    underlying model or vendor, so a break-character leak never reaches the
 *    user even when the prompt-level identity rule fails under task-stress.
 * 2. `stripBannedRituals` — remove ritual phrases the model leaks despite
 *    response-style.md banning them.
 * 3. Empty-response guard — substitute a clarifying fallback if the model
 *    returned no content (or only ritual/persona-collapse text that all got
 *    removed).
 *
 * Concision belongs in the response instructions. Never shorten a completed
 * answer based on question length: that can remove records, action receipts,
 * code, or required steps while leaving an apparently complete answer.
 * The client retains its separate, explicitly reported output-size guard.
 *
 * Used at every assistant-text return site in `claude-client.ts` so the
 * pipeline is consistent across non-streaming, multi-textblock, and
 * streaming `done` paths.
 *
 * @param _question Retained for existing callers; question length does not limit completeness.
 * @param rawText The raw assistant text from the model (post-tool-use).
 * @returns The post-processed text safe to return to the caller.
 */
export function applyResponsePipeline(_question: string, rawText: string): string {
  const personaSafe = rewritePersonaCollapse(rawText);
  const stripped = stripBannedRituals(personaSafe);
  if (stripped.trim().length === 0) {
    return EMPTY_RESPONSE_FALLBACK;
  }
  return stripped;
}

/** Test-only export of the empty-response fallback. */
export const __test_EMPTY_RESPONSE_FALLBACK = EMPTY_RESPONSE_FALLBACK;
