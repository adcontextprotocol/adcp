import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listWorkingGroupsWithSlackChannel = vi.fn();
const getChannelInfo = vi.fn();
const getChannelHistory = vi.fn();
const getFileContent = vi.fn();
const upsertFilePr = vi.fn();
const messagesCreate = vi.fn();

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    listWorkingGroupsWithSlackChannel = listWorkingGroupsWithSlackChannel;
  },
}));

vi.mock('../../src/slack/client.js', () => ({
  getChannelInfo,
  getChannelHistory,
}));

vi.mock('../../src/addie/jobs/github-pr.js', () => ({
  getFileContent,
  upsertFilePr,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

vi.mock('../../src/config/models.js', () => ({
  ModelConfig: { primary: 'test-model', fast: 'test-model' },
}));

function wg(name: string, channelId: string) {
  return { id: `id-${channelId}`, name, slack_channel_id: channelId };
}

function message(text: string, replyCount = 3, ts = '1700000000.000100') {
  return { type: 'message', user: 'U1', text, ts, reply_count: replyCount };
}

function llmText(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('runWgSlackContextJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    listWorkingGroupsWithSlackChannel.mockResolvedValue([wg('Media Buy WG', 'C001')]);
    getChannelInfo.mockResolvedValue({ id: 'C001', is_private: false });
    getChannelHistory.mockResolvedValue({
      messages: [message('Long discussion about create_media_buy pacing semantics and #1234')],
      hasMore: false,
    });
    messagesCreate.mockResolvedValue(
      llmText('### Pacing semantics\n- **Status:** active\n- **Summary:** Members discussed pacing.\n- **Related:** #1234')
    );
    getFileContent.mockResolvedValue(null);
    upsertFilePr.mockResolvedValue({ prUrl: 'https://github.com/x/pr/1', prNumber: 1, created: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips when today\'s digest already exists on the PR branch', async () => {
    const today = new Date().toISOString().slice(0, 10);
    getFileContent.mockResolvedValue(`# WG Slack Context\n\n- Generated: ${today}\n\n---\n\nold body\n`);
    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    const result = await runWgSlackContextJob();
    expect(result.skipped).toBe('already-ran-today');
    expect(getChannelHistory).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('proceeds when the existing digest is from an earlier day', async () => {
    getFileContent.mockResolvedValue('# WG Slack Context\n\n- Generated: 2020-01-01\n\n---\n\nold body\n');
    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    const result = await runWgSlackContextJob();
    expect(result.skipped).toBeUndefined();
    expect(result.prUrl).toBe('https://github.com/x/pr/1');
  });

  it('skips entirely when env credentials are missing', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    const result = await runWgSlackContextJob();
    expect(result.skipped).toBe('missing-env');
    expect(listWorkingGroupsWithSlackChannel).not.toHaveBeenCalled();
  });

  it('distills public channels and opens a PR', async () => {
    const { runWgSlackContextJob, CONTEXT_FILE_PATH } = await import(
      '../../src/addie/jobs/wg-slack-context.js'
    );
    const result = await runWgSlackContextJob();

    expect(result.channelsScanned).toBe(1);
    expect(result.threadsDistilled).toBe(1);
    expect(result.prUrl).toBe('https://github.com/x/pr/1');
    expect(upsertFilePr).toHaveBeenCalledTimes(1);
    const call = upsertFilePr.mock.calls[0][0];
    expect(call.path).toBe(CONTEXT_FILE_PATH);
    expect(call.content).toContain('Background only');
    expect(call.content).toContain('### Pacing semantics');
  });

  it('excludes private channels and fails closed on unknown privacy', async () => {
    listWorkingGroupsWithSlackChannel.mockResolvedValue([
      wg('Public WG', 'C001'),
      wg('Private WG', 'C002'),
      wg('Unknown WG', 'C003'),
    ]);
    getChannelInfo.mockImplementation(async (id: string) => {
      if (id === 'C001') return { id, is_private: false };
      if (id === 'C002') return { id, is_private: true };
      return null;
    });

    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    const result = await runWgSlackContextJob();

    expect(result.channelsScanned).toBe(1);
    expect(result.channelsSkippedPrivate).toBe(2);
    expect(getChannelHistory).toHaveBeenCalledTimes(1);
    expect(getChannelHistory).toHaveBeenCalledWith('C001', expect.anything());
  });

  it('skips without a PR when the distiller finds nothing spec-relevant', async () => {
    messagesCreate.mockResolvedValue(llmText('NO_SPEC_RELEVANT_DISCUSSION'));
    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    const result = await runWgSlackContextJob();
    expect(result.skipped).toBe('no-spec-content');
    expect(upsertFilePr).not.toHaveBeenCalled();
  });

  it('skips when the distilled body matches the file already on main', async () => {
    const body =
      '### Pacing semantics\n- **Status:** active\n- **Summary:** Members discussed pacing.\n- **Related:** #1234';
    messagesCreate.mockResolvedValue(llmText(body));
    getFileContent.mockResolvedValue(`# WG Slack Context\n\nmeta lines\n\n---\n\n${body}\n`);

    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    const result = await runWgSlackContextJob();
    expect(result.skipped).toBe('no-material-change');
    expect(upsertFilePr).not.toHaveBeenCalled();
  });

  it('strips residual Slack mentions from model output before shipping', async () => {
    messagesCreate.mockResolvedValue(
      llmText('### Topic\n- **Summary:** <@U12345ABC> proposed a change.')
    );
    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    await runWgSlackContextJob();
    const call = upsertFilePr.mock.calls[0][0];
    expect(call.content).not.toContain('<@U');
    expect(call.content).toContain('a member proposed a change');
  });

  it('reports no-activity when channels have no substantive threads', async () => {
    getChannelHistory.mockResolvedValue({
      messages: [{ type: 'message', bot_id: 'B1', text: 'bot noise', ts: '1.0' }],
      hasMore: false,
    });
    const { runWgSlackContextJob } = await import('../../src/addie/jobs/wg-slack-context.js');
    const result = await runWgSlackContextJob();
    expect(result.skipped).toBe('no-activity');
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe('cleanSlackText', () => {
  it('replaces mentions, unwraps channel refs and links', async () => {
    const { cleanSlackText } = await import('../../src/addie/jobs/wg-slack-context.js');
    expect(cleanSlackText('<@U123ABC> said see <#C1|wg-adcp> and <https://x.test|the doc>')).toBe(
      'a member said see #wg-adcp and the doc'
    );
    expect(cleanSlackText('bare <https://x.test/page>')).toBe('bare https://x.test/page');
  });
});
