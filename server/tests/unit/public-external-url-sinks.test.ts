import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const publicRoot = join(process.cwd(), 'server/public');
const guardSource = readFileSync(join(publicRoot, 'external-url.js'), 'utf8');
const slackCtaSource = readFileSync(join(publicRoot, 'slack-cta.js'), 'utf8');

function loadGuard(): (value: unknown) => string {
  const context = vm.createContext({ window: {}, URL });
  vm.runInContext(guardSource, context);
  return (context.window as { safeExternalHttpUrl: (value: unknown) => string })
    .safeExternalHttpUrl;
}

function loadSlackCta(): (options: {
  inviteUrl?: unknown;
  channelUrl?: unknown;
  isLinkedToSlack?: boolean;
}) => { url: string; label: string } {
  const context = vm.createContext({ window: {}, URL });
  vm.runInContext(guardSource, context);
  vm.runInContext(slackCtaSource, context);
  return (context.window as {
    resolveSlackCta: ReturnType<typeof loadSlackCta>;
  }).resolveSlackCta;
}

describe('public external URL navigation guard', () => {
  it('accepts only absolute HTTP(S) URLs without credentials', () => {
    const safeExternalHttpUrl = loadGuard();

    expect(safeExternalHttpUrl(' https://example.com/story?q=1 '))
      .toBe('https://example.com/story?q=1');
    expect(safeExternalHttpUrl('http://example.com')).toBe('http://example.com/');
    expect(safeExternalHttpUrl('javascript:alert(document.domain)')).toBe('');
    expect(safeExternalHttpUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeExternalHttpUrl('https://user:secret@example.com/story')).toBe('');
    expect(safeExternalHttpUrl('/relative/path')).toBe('');
  });

  it.each([
    ['members.html', 'getSafePerspectiveExternalUrl(p.external_url)'],
    ['stories/index.html', 'getSafePerspectiveExternalUrl(item.external_url)'],
    ['community/person-profile.html', 'getSafePerspectiveExternalUrl(p.external_url)'],
    ['working-groups/detail.html', 'getSafePerspectiveExternalUrl(post.external_url)'],
  ])('guards legacy external URLs in %s', (relativePath, guardedCall) => {
    const source = readFileSync(join(publicRoot, relativePath), 'utf8');

    expect(source).toContain('<script src="/perspective-url.js"></script>');
    expect(source).toContain(guardedCall);
  });

  it.each([
    ['community/person-profile.html', 'getSafeHttpsUrl(data.linkedin_url)'],
    ['community/person-profile.html', 'getSafeHttpsUrl(data.twitter_url)'],
    ['membership/hub.html', 'getSafeHttpsUrl(profile.linkedin_url)'],
    ['membership/hub.html', 'getSafeHttpsUrl(profile.twitter_url)'],
    ['admin-feeds.html', 'getSafePerspectiveExternalUrl(article.external_url)'],
    ['stories/index.html', 'getSafePerspectiveExternalUrl(item.source_url)'],
  ])('uses the specialized HTTPS guard in %s', (relativePath, guardedCall) => {
    const source = readFileSync(join(publicRoot, relativePath), 'utf8');
    expect(source).toContain(guardedCall);
  });

  it('guards account-enrichment LinkedIn links', () => {
    const source = readFileSync(join(publicRoot, 'admin-account-detail.html'), 'utf8');
    expect(source).toContain('linkedInSignalRow(a.enrichment.linkedin_url)');
    expect(source).toContain('getSafeLinkedInUrl(value)');
  });

  it('routes Slack CTAs by actual Slack linkage with safe fallbacks', () => {
    const resolveSlackCta = loadSlackCta();
    const inviteUrl = 'https://join.slack.com/t/agenticads/shared_invite/example';
    const channelUrl = 'https://app.slack.com/client/workspace/channel';

    expect(resolveSlackCta({ inviteUrl, channelUrl })).toEqual({
      url: inviteUrl,
      label: 'Join Slack Workspace',
    });
    expect(resolveSlackCta({ inviteUrl, channelUrl, isLinkedToSlack: false })).toEqual({
      url: inviteUrl,
      label: 'Join Slack Workspace',
    });
    expect(resolveSlackCta({ inviteUrl, channelUrl, isLinkedToSlack: true })).toEqual({
      url: channelUrl,
      label: 'Open Slack Channel',
    });
    expect(resolveSlackCta({ inviteUrl: 'javascript:alert(1)', channelUrl })).toEqual({
      url: channelUrl,
      label: 'Join Slack Workspace',
    });
    expect(resolveSlackCta({ inviteUrl, channelUrl: 'data:text/html,bad', isLinkedToSlack: true })).toEqual({
      url: inviteUrl,
      label: 'Join Slack Workspace',
    });
    expect(resolveSlackCta({ inviteUrl: '/relative', channelUrl: 'not a url' })).toEqual({
      url: '',
      label: 'Join Slack Workspace',
    });
  });

  it('exposes Slack linkage and uses the shared CTA resolver', () => {
    const source = readFileSync(join(publicRoot, 'working-groups/detail.html'), 'utf8');
    const httpSource = readFileSync(join(process.cwd(), 'server/src/http.ts'), 'utf8');

    expect(httpSource).toContain('slackInviteUrl: SLACK_JOIN_GUIDE_URL');
    expect(httpSource).toContain('isLinkedToSlack,');
    expect(source).toContain('isLinkedToSlack = config.user?.isLinkedToSlack === true');
    expect(source).toContain('const slackCta = resolveSlackCta({');
    expect(source).toContain('slackBtn.href = slackCta.url');
  });

  it.each([
    ['admin-content.html', 'safeExternalHttpUrl(item.external_url)'],
    ['admin-account-detail.html', 'safeExternalHttpUrl(invoice.hosted_invoice_url)'],
    ['working-groups/detail.html', 'safeExternalHttpUrl(currentGroup.slack_channel_url)'],
    ['working-groups/detail.html', 'safeExternalHttpUrl(meeting.zoom_join_url)'],
    ['working-groups/detail.html', 'safeExternalHttpUrl(doc.document_url)'],
    ['working-groups/detail.html', 'safeExternalHttpUrl(data?.cta_url)'],
    ['admin-account-detail.html', 'safeExternalHttpUrl(pendingInvoice.hosted_invoice_url)'],
    ['chat.html', 'safeExternalHttpUrl(data.url)'],
    ['chat.html', 'safeExternalHttpUrl(item.url)'],
    ['chat.html', 'safeExternalHttpUrl(data.url || data.image_url)'],
    ['chat.html', 'safeExternalHttpUrl(data.image || data.image_url)'],
    ['chat.html', 'safeExternalHttpUrl(item.image || item.image_url)'],
  ])('guards the browser navigation sink in %s', (relativePath, guardedCall) => {
    const source = readFileSync(join(publicRoot, relativePath), 'utf8');
    expect(source).toContain('<script src="/external-url.js"></script>');
    expect(source).toContain(guardedCall);
  });

  it('guards both A2UI ProductCard and Card image renderers', () => {
    const source = readFileSync(join(publicRoot, 'chat.html'), 'utf8');
    expect(source.match(/safeExternalHttpUrl\(siResolveBoundValue\(props\.image/g)?.length)
      .toBeGreaterThanOrEqual(2);
  });
});
