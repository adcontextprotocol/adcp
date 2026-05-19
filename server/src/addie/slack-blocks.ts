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
    const window = remaining.slice(0, SLACK_SECTION_MRKDWN_LIMIT);
    let cut = window.lastIndexOf('\n\n');
    if (cut < SLACK_SECTION_MRKDWN_LIMIT / 2) cut = window.lastIndexOf('\n');
    if (cut < SLACK_SECTION_MRKDWN_LIMIT / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = SLACK_SECTION_MRKDWN_LIMIT;
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
 * Cap a top-level `text` notification fallback. Slack will accept up to
 * 40k, but there's no reason to send the full reply twice — clamp to one
 * section's worth so we can't trip `msg_too_long` here.
 */
export function truncateNotificationText(text: string): string {
  if (text.length <= SLACK_SECTION_MRKDWN_LIMIT) return text;
  return text.slice(0, SLACK_SECTION_MRKDWN_LIMIT - 1) + '…';
}
