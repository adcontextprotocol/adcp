/**
 * Deterministic shape metrics for Addie's responses.
 *
 * The red-team runner already enforces a 160-word cap on questions <15 words
 * (see redteam-runner.ts). That catches yes/no challenges but misses the
 * shape Brian flagged in the registry thread: a 21-word multi-part question
 * answered with a 280-word essay-shaped response (intro → bold heading →
 * bullets → bold heading → bullets → closing question).
 *
 * This module exposes a single shared shape grader so:
 *   - The red-team runner can extend its checks beyond static-scenario flags.
 *   - The shadow evaluator can score live-thread shape divergence between
 *     Addie and the human responder.
 *   - Future post-processors can use the same template detector.
 *
 * Metrics are deterministic (no LLM) and cheap to compute. Keep this module
 * dependency-free so any caller can import it.
 */
import { BANNED_RITUALS } from '../response-postprocess.js';

export interface QuestionShape {
  wordCount: number;
  /** Question contains 'and', 'plus', 'also', or two question marks. */
  isMultiPart: boolean;
  /**
   * Calibrated word-count ceiling for a response of this shape, drawn from
   * response-style.md's word-count table:
   *   ≤15 words → 120
   *   16–30 words → 200
   *   >30 words → scales with question length (×8), capped at 400
   * Multi-part is a question-shape signal but does not by itself grant
   * extra word budget — response-style.md says each part still gets the
   * treatment its shape deserves, not that the budget compounds.
   */
  expectedMaxWords: number;
}

export interface ResponseShape {
  wordCount: number;
  /** `**Foo**` or `**Foo:**` lines — the "bold heading" register. */
  boldHeadingCount: number;
  /** Lines starting with `-`, `*`, or `•`. */
  bulletCount: number;
  /** Lines starting with `1.`, `2.`, etc. */
  numberedListCount: number;
  /** Trimmed response ends with `?`. */
  endsWithQuestion: boolean;
  /**
   * The default-template signature flagged in response-style.md:
   * "intro → bold heading → bullets → bold heading → bullets → closing question."
   * Detected as ≥2 bold headings AND ≥4 bullets/numbered items AND ending question.
   */
  usesDefaultTemplate: boolean;
  /** Banned ritual phrases from response-postprocess.ts that leaked through. */
  bannedRitualHits: string[];
  /**
   * Response opens with a sign-in / no-tools disclaimer. response-style.md
   * bans these as openers ("I don't have X tools, but…", "Since you're not
   * signed in, …", "Without access to real-time data, …").
   */
  signInOpenerHit: boolean;
}

export interface ShapeViolations {
  /** True when response wordCount exceeds the question's expectedMaxWords. */
  exceededLengthCap: boolean;
  /** response.wordCount / question.expectedMaxWords. >1.0 = over budget. */
  ratioToExpected: number;
  /** ResponseShape.usesDefaultTemplate. Lifted for callers to short-circuit on. */
  defaultTemplateUsed: boolean;
  /** Banned ritual phrases observed (lowercase). */
  bannedRituals: string[];
  /** Sign-in / no-tools disclaimer used as the response opener. */
  signInDeflectionInOpener: boolean;
  /**
   * "Comprehensive list dump" — many bullets or numbered items in response
   * to a single-part question. response-style.md: "Don't dump comprehensive
   * lists in response to list-shaped questions." Detected when the response
   * has ≥6 list items (bullets + numbered) AND the question is not
   * multi-part. Length is not part of the check — a short bullet dump is
   * still a dump.
   */
  comprehensiveDumpDetected: boolean;
}

export interface ShapeReport {
  question: QuestionShape;
  response: ResponseShape;
  violations: ShapeViolations;
  /** Concise list of violation labels for logging / persistence. */
  violationLabels: string[];
}

const SIGNIN_OPENER_PATTERNS: readonly string[] = [
  "i don't have",
  'i do not have',
  "since you're not signed in",
  'since you are not signed in',
  'without access to',
  "i don't currently have",
  'i do not currently have',
];

const OPENER_WINDOW_CHARS = 200;

function countWords(s: string): number {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function classifyQuestion(question: string): QuestionShape {
  const wordCount = countWords(question);
  const questionMarks = (question.match(/\?/g) || []).length;
  const hasConjunction = /\b(and|also|plus)\b/i.test(question);
  const isMultiPart = questionMarks >= 2 || hasConjunction;

  let expectedMaxWords: number;
  if (wordCount <= 15) expectedMaxWords = 120;
  else if (wordCount <= 30) expectedMaxWords = 200;
  else expectedMaxWords = Math.min(400, wordCount * 8);

  return { wordCount, isMultiPart, expectedMaxWords };
}

export function analyzeResponseShape(response: string): ResponseShape {
  const wordCount = countWords(response);

  const lines = response.split('\n');

  // Bold heading: a whole line that is **text** or **text:**, optionally
  // with surrounding whitespace. Inline bolding ("foo **bar** baz") doesn't
  // count — only standalone heading-like lines.
  const boldHeadingCount = lines.filter((line) => {
    const t = line.trim();
    return /^\*\*[^*\n]+\*\*:?\s*$/.test(t);
  }).length;

  const bulletCount = lines.filter((line) => /^\s*[-*•]\s+\S/.test(line)).length;

  const numberedListCount = lines.filter((line) => /^\s*\d+\.\s+\S/.test(line)).length;

  const trimmed = response.trim();
  const endsWithQuestion = trimmed.endsWith('?');

  const usesDefaultTemplate =
    boldHeadingCount >= 2 &&
    bulletCount + numberedListCount >= 4 &&
    endsWithQuestion;

  const lower = response.toLowerCase();
  const bannedRitualHits = BANNED_RITUALS.filter((phrase) =>
    lower.includes(phrase.toLowerCase()),
  );

  const opener = lower.slice(0, OPENER_WINDOW_CHARS);
  const signInOpenerHit = SIGNIN_OPENER_PATTERNS.some((p) => opener.includes(p));

  return {
    wordCount,
    boldHeadingCount,
    bulletCount,
    numberedListCount,
    endsWithQuestion,
    usesDefaultTemplate,
    bannedRitualHits,
    signInOpenerHit,
  };
}

export function gradeShape(question: string, response: string): ShapeReport {
  const q = classifyQuestion(question);
  const r = analyzeResponseShape(response);

  const ratioToExpected = q.expectedMaxWords > 0
    ? r.wordCount / q.expectedMaxWords
    : 0;

  const exceededLengthCap = r.wordCount > q.expectedMaxWords;

  const comprehensiveDumpDetected =
    !q.isMultiPart && r.bulletCount + r.numberedListCount >= 6;

  const violations: ShapeViolations = {
    exceededLengthCap,
    ratioToExpected,
    defaultTemplateUsed: r.usesDefaultTemplate,
    bannedRituals: r.bannedRitualHits,
    signInDeflectionInOpener: r.signInOpenerHit,
    comprehensiveDumpDetected,
  };

  const labels: string[] = [];
  if (exceededLengthCap) {
    labels.push(`length_cap(${r.wordCount}>${q.expectedMaxWords})`);
  }
  if (r.usesDefaultTemplate) labels.push('default_template');
  if (comprehensiveDumpDetected) labels.push('comprehensive_dump');
  if (r.signInOpenerHit) labels.push('signin_opener');
  for (const phrase of r.bannedRitualHits) {
    labels.push(`ritual:${phrase}`);
  }

  return {
    question: q,
    response: r,
    violations,
    violationLabels: labels,
  };
}
