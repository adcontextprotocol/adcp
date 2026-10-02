import { describe, expect, it } from 'vitest';
import {
  extractSlackMessageContent,
  isSupportedSlackMessageSubtype,
} from '../../../src/addie/slack-message-content.js';
import { buildThreadSummaryForRouter } from '../../../src/addie/thread-utils.js';

const file = {
  id: 'F_UPLOAD',
  title: 'Publisher manifest',
  name: 'adagents.json',
  filetype: 'json',
  url_private: 'https://files.slack.com/files-pri/T_TEST-F_UPLOAD/adagents.json',
  permalink: 'https://example.slack.com/files/U_TEST/F_UPLOAD',
};

describe('Slack uploads', () => {
  it('provides file-only uploads with the filename and authenticated download URL', () => {
    const content = extractSlackMessageContent({ text: '', files: [file] });
    expect(content).toContain('[Shared files]');
    expect(content).toContain('File: adagents.json');
    expect(content).toContain(file.url_private);
    expect(content).not.toContain(file.permalink);
  });

  it('keeps text, forwarded content, and uploads together', () => {
    const content = extractSlackMessageContent({
      text: 'Validate this',
      attachments: [{ author_name: 'Sam', text: 'Our publisher manifest' }],
      files: [file],
    });
    expect(content).toContain('Validate this');
    expect(content).toContain('From: Sam\nOur publisher manifest');
    expect(content).toContain(file.url_private);
  });

  it('retains a previous file-only upload when routing a later validation request', () => {
    const summary = buildThreadSummaryForRouter([
      { ts: '1', user: 'U_TEST', files: [file] },
      { ts: '2', user: 'U_TEST', text: 'Can you validate it?' },
    ], 'B_ADDIE', '2', 'U_TEST');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('You:');
    expect(summary[0]).toContain(file.url_private);
  });

  it.each([undefined, 'file_share'])('accepts user message subtype %s', subtype => {
    expect(isSupportedSlackMessageSubtype(subtype)).toBe(true);
  });

  it.each(['message_changed', 'message_deleted', 'channel_join', 'bot_message'])(
    'keeps system subtype %s out of response processing', subtype => {
      expect(isSupportedSlackMessageSubtype(subtype)).toBe(false);
    },
  );
});
