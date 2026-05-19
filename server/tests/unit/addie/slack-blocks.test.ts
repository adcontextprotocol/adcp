import { describe, it, expect } from 'vitest';
import {
  splitMrkdwnIntoSections,
  truncateNotificationText,
  SLACK_SECTION_MRKDWN_LIMIT,
  SLACK_SECTION_HARD_LIMIT,
  SLACK_MAX_SECTION_BLOCKS,
  type SlackSectionBlock,
} from '../../../src/addie/slack-blocks.js';

/**
 * Assert a value matches Slack's section-block shape and stays under the
 * hard cap. Catches typo regressions (`type: 'mrkdown'`, empty text) that
 * would only surface at Slack with `invalid_blocks`.
 */
function expectValidSection(s: unknown): asserts s is SlackSectionBlock {
  expect(s).toMatchObject({
    type: 'section',
    text: { type: 'mrkdwn' },
  });
  const block = s as SlackSectionBlock;
  expect(typeof block.text.text).toBe('string');
  expect(block.text.text.length).toBeGreaterThan(0);
  expect(block.text.text.length).toBeLessThan(SLACK_SECTION_HARD_LIMIT);
}

describe('splitMrkdwnIntoSections', () => {
  it('returns no sections for an empty string', () => {
    expect(splitMrkdwnIntoSections('')).toEqual([]);
  });

  it('returns a single section when text fits under the cap', () => {
    const sections = splitMrkdwnIntoSections('hello');
    expect(sections).toHaveLength(1);
    expectValidSection(sections[0]);
    expect(sections[0].text.text).toBe('hello');
  });

  it('keeps input exactly at the soft limit in a single section', () => {
    const exact = 'a'.repeat(SLACK_SECTION_MRKDWN_LIMIT);
    const sections = splitMrkdwnIntoSections(exact);
    expect(sections).toHaveLength(1);
    expect(sections[0].text.text.length).toBe(SLACK_SECTION_MRKDWN_LIMIT);
  });

  it('splits input one char over the soft limit into two sections', () => {
    const overflow = 'a'.repeat(SLACK_SECTION_MRKDWN_LIMIT + 1);
    const sections = splitMrkdwnIntoSections(overflow);
    expect(sections).toHaveLength(2);
    for (const s of sections) expectValidSection(s);
  });

  it('hard-cuts a single whitespace-free token at the section limit', () => {
    // Realistic shape: a long URL / base64 blob with no break points.
    const token = 'https://example.com/' + 'x'.repeat(5000);
    const sections = splitMrkdwnIntoSections(token);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expectValidSection(s);
      expect(s.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_MRKDWN_LIMIT);
    }
    // Cuts at the soft limit, so rejoining recovers the original.
    expect(sections.map(s => s.text.text).join('')).toBe(token);
  });

  it('produces multiple sections each within the per-section limit', () => {
    const long = 'word '.repeat(2000); // ~10000 chars
    const sections = splitMrkdwnIntoSections(long);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expectValidSection(s);
      expect(s.text.text.length).toBeLessThan(SLACK_SECTION_HARD_LIMIT);
    }
  });

  it('prefers paragraph boundaries when splitting', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `para ${i} `.repeat(200)).join('\n\n');
    const sections = splitMrkdwnIntoSections(paragraphs);
    // Every break should land at a paragraph boundary — no section should start
    // with a half-word from the previous paragraph.
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].text.text.startsWith('para ')).toBe(true);
    }
  });

  it('preserves markdown list markers across a chunk boundary', () => {
    // The whitespace-strip at chunk boundaries drops leading `\n`, but list
    // markers (`- item`) at start-of-section still render. This pins that
    // trade-off: if a regression made the splitter drop the `- ` itself,
    // this test would catch it.
    const items = Array.from({ length: 400 }, (_, i) => `- list item ${i} with some prose to fill space`).join('\n');
    const sections = splitMrkdwnIntoSections(items);
    expect(sections.length).toBeGreaterThan(1);
    for (let i = 1; i < sections.length; i++) {
      // Second and subsequent sections must start with a list marker, not
      // a half-word from the previous section's last item.
      expect(sections[i].text.text.startsWith('- list item ')).toBe(true);
    }
  });

  it('tags the last block when input exceeds max block count (hard-cut path)', () => {
    const oversized = 'x'.repeat(SLACK_SECTION_MRKDWN_LIMIT * (SLACK_MAX_SECTION_BLOCKS + 2));
    const sections = splitMrkdwnIntoSections(oversized);
    expect(sections.length).toBe(SLACK_MAX_SECTION_BLOCKS);
    expect(sections[sections.length - 1].text.text).toMatch(/_\(response truncated\)_/);
  });

  it('tags the last block when paragraph-style input exceeds max block count', () => {
    // Same overflow case but with natural break points, so the splitter
    // goes through the `lastIndexOf('\n\n')` branch. A regression that
    // only broke the truncation marker on the boundary path wouldn't be
    // caught by the hard-cut test above.
    const paragraph = ('sentence words words words words. '.repeat(80) + '\n\n');
    const oversized = paragraph.repeat(SLACK_MAX_SECTION_BLOCKS + 2);
    const sections = splitMrkdwnIntoSections(oversized);
    expect(sections.length).toBe(SLACK_MAX_SECTION_BLOCKS);
    expect(sections[sections.length - 1].text.text).toMatch(/_\(response truncated\)_/);
  });
});

describe('truncateNotificationText', () => {
  it('returns input unchanged when within the section limit', () => {
    expect(truncateNotificationText('short')).toBe('short');
  });

  it('returns input unchanged at exactly the section limit', () => {
    const exact = 'a'.repeat(SLACK_SECTION_MRKDWN_LIMIT);
    expect(truncateNotificationText(exact)).toBe(exact);
  });

  it('caps text one char over the limit with an ellipsis', () => {
    const oneOver = 'a'.repeat(SLACK_SECTION_MRKDWN_LIMIT + 1);
    const out = truncateNotificationText(oneOver);
    expect(out.length).toBe(SLACK_SECTION_MRKDWN_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });

  it('caps long text at the section limit with an ellipsis', () => {
    const oversized = 'a'.repeat(SLACK_SECTION_MRKDWN_LIMIT * 2);
    const out = truncateNotificationText(oversized);
    expect(out.length).toBe(SLACK_SECTION_MRKDWN_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });
});
