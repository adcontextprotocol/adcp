/**
 * Slack Block Kit length-safe helpers.
 *
 * Slack rejects a `section.text.text` mrkdwn body over 3000 chars with
 * `invalid_blocks`, and a top-level `text` (notification fallback) over
 * 40000 chars with `msg_too_long`. Any code path that posts model-generated
 * or otherwise-unbounded content should run it through these helpers
 * before handing it to `chat.postMessage` / `say()`.
 */

/** Slack's hard cap on `section.text.text`. Exceeding this returns `invalid_blocks`. */
export const SLACK_SECTION_HARD_LIMIT = 3000;

/** Per-section mrkdwn cap with headroom for safety. */
export const SLACK_SECTION_MRKDWN_LIMIT = 2900;

/** Soft cap on how many section blocks one message will produce. */
export const SLACK_MAX_SECTION_BLOCKS = 40;

export interface SlackSectionBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
}

/**
 * Find a cut index in `text` no later than `maxLen` that lands on a
 * paragraph boundary if possible, then a line boundary, then a word
 * boundary. Falls back to a hard cut at `maxLen` when the text has no
 * usable break points (e.g. a long URL or base64 blob).
 *
 * The "half of max" thresholds prefer a later cut: a paragraph break in
 * the first half of the window means we'd lose too much text to that
 * preference, so fall through to line/word cuts that pack more in.
 */
function findSafeCut(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;
  const window = text.slice(0, maxLen);
  let cut = window.lastIndexOf('\n\n');
  if (cut < maxLen / 2) cut = window.lastIndexOf('\n');
  if (cut < maxLen / 2) cut = window.lastIndexOf(' ');
  if (cut <= 0) cut = maxLen;
  return cut;
}

/**
 * Split `text` into Slack `section` blocks each no longer than
 * `SLACK_SECTION_MRKDWN_LIMIT`. Prefers paragraph, then line, then word
 * boundaries. Caps at `SLACK_MAX_SECTION_BLOCKS`; if input is longer,
 * the last block is suffixed with `_(response truncated)_`.
 */
export function splitMrkdwnIntoSections(text: string): SlackSectionBlock[] {
  const sections: SlackSectionBlock[] = [];
  let remaining = text;
  while (remaining.length > 0 && sections.length < SLACK_MAX_SECTION_BLOCKS) {
    if (remaining.length <= SLACK_SECTION_MRKDWN_LIMIT) {
      sections.push({ type: 'section', text: { type: 'mrkdwn', text: remaining } });
      remaining = '';
      break;
    }
    const cut = findSafeCut(remaining, SLACK_SECTION_MRKDWN_LIMIT);
    sections.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, cut) } });
    // Strip leading whitespace at the chunk boundary. The leading `\n` we cut
    // on is decorative — list markers (`- item`, `1. item`) at start-of-section
    // still render. Indented continuations would be mangled, but that's the
    // pragmatic trade for never trailing into a half-word.
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining.length > 0 && sections.length > 0) {
    const last = sections[sections.length - 1];
    last.text.text = `${last.text.text}\n\n_(response truncated)_`;
  }
  return sections;
}

/**
 * Default soft cap on Slack-streamed message length. Slack's server
 * rejects `chat.stopStream` with `msg_too_long` once the cumulative
 * streamed content crosses an internal cap; the exact number is not
 * documented but reports cluster around 12000 chars. We pick a
 * conservative default that leaves headroom for the continuation
 * marker, any in-flight SDK buffer, and the feedback block.
 *
 * Tunable via the `ADDIE_STREAM_SOFT_CAP` env var.
 */
export const DEFAULT_STREAM_SOFT_CAP = 9000;

export interface StreamAppendDecision {
  /** Pass to `streamer.append({ markdown_text: appendPart })` when non-empty. */
  appendPart: string;
  /** Accumulate into the continuation buffer when non-empty. */
  carryPart: string;
  /** True iff this delta crossed the cap and the stream must be finalized. */
  shouldFinalize: boolean;
}

/**
 * Decide how to handle the next streamed delta given how much has
 * already been streamed. While we're under `softCap`, the entire delta
 * gets appended. When this delta would cross `softCap`, we split it at
 * the latest safe boundary that still fits: the prefix is streamed,
 * the remainder is carried into the continuation buffer, and the
 * caller must finalize the stream + post the buffer as a follow-up.
 */
export function decideStreamAppend(
  streamedLen: number,
  delta: string,
  softCap: number,
): StreamAppendDecision {
  if (streamedLen + delta.length <= softCap) {
    return { appendPart: delta, carryPart: '', shouldFinalize: false };
  }
  const budget = Math.max(0, softCap - streamedLen);
  if (budget === 0) {
    return { appendPart: '', carryPart: delta, shouldFinalize: true };
  }
  const cut = findSafeCut(delta, budget);
  return {
    appendPart: delta.slice(0, cut),
    carryPart: delta.slice(cut),
    shouldFinalize: true,
  };
}

/**
 * Cap a top-level `text` notification fallback. Slack will accept up to
 * 40k, but there's no reason to send the full reply twice — clamp to one
 * section's worth so we can't trip `msg_too_long` here.
 */
export function truncateNotificationText(text: string): string {
  if (text.length <= SLACK_SECTION_MRKDWN_LIMIT) return text;
  return text.slice(0, SLACK_SECTION_MRKDWN_LIMIT - 1) + '…';
}
