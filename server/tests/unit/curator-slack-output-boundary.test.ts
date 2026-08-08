import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { escapeSlackText } from '../../src/utils/slack-escape.js';

describe('curator Slack output boundary', () => {
  it('neutralizes model-controlled mentions and mrkdwn links', () => {
    expect(escapeSlackText('<!channel> review <https://attacker.example|this>', 1_000))
      .toBe('&lt;!channel&gt; review &lt;https://attacker.example|this&gt;');
  });

  it('escapes curator notes at every Slack delivery boundary', async () => {
    const alerts = await readFile(
      new URL('../../src/addie/services/industry-alerts.ts', import.meta.url),
      'utf8',
    );
    const replies = await readFile(
      new URL('../../src/addie/services/community-articles.ts', import.meta.url),
      'utf8',
    );

    expect(alerts).toContain('escapeSlackText(article.addie_notes, 1_000)');
    expect(replies).toContain('escapeSlackText(article.addie_notes, 1_000)');
  });
});
