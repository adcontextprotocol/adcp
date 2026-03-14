/**
 * Comparison test: local creative agent vs live reference agent.
 *
 * Calls list_creative_formats on the live reference agent at
 * creative.adcontextprotocol.org and compares format IDs, names,
 * and structure against our local implementation.
 *
 * Skipped by default — run with:
 *   COMPARE_LIVE=1 npx vitest run server/tests/integration/creative-agent-comparison.test.ts
 */

import { describe, it, expect } from 'vitest';
import { CreativeAgentClient, callMCPTool, STANDARD_CREATIVE_AGENTS } from '@adcp/client';
import { buildReferenceFormats, handleListCreativeFormats, handlePreviewCreative } from '../../src/creative-agent/task-handlers.js';

const SKIP = !process.env.COMPARE_LIVE;
const TEST_AGENT_URL = 'https://creative.adcontextprotocol.org';
// The live agent uses a trailing slash in agent_url
const LIVE_AGENT_URL = 'https://creative.adcontextprotocol.org/';
const LIVE_MCP_URL = STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE;

/** Call a tool on the live agent via MCP and return parsed structured content. */
async function callLiveTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  const result = await callMCPTool(LIVE_MCP_URL, toolName, args);
  if (result?.isError) {
    const text = result.content?.[0]?.text || 'Unknown error';
    throw new Error(`Live agent error: ${text}`);
  }
  // MCP SDK returns { content, structuredContent, isError }
  if (result?.structuredContent) return result.structuredContent;
  if (Array.isArray(result?.content)) {
    const textItem = result.content.find((c: any) => c.type === 'text');
    if (textItem?.text) {
      try { return JSON.parse(textItem.text); } catch { return textItem.text; }
    }
  }
  return result;
}

describe.skipIf(SKIP)('comparison: local vs live reference agent', () => {
  it('local format count matches live agent', async () => {
    const client = new CreativeAgentClient({
      agentUrl: STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE,
    });

    const liveFormats = await client.listFormats();
    const localFormats = buildReferenceFormats(TEST_AGENT_URL);

    console.log(`Live agent: ${liveFormats.length} formats`);
    console.log(`Local agent: ${localFormats.length} formats`);

    // Log any differences
    const liveIds = new Set(liveFormats.map(f => f.format_id.id));
    const localIds = new Set(localFormats.map(f => (f.format_id as { id: string }).id));

    const onlyInLive = [...liveIds].filter(id => !localIds.has(id));
    const onlyInLocal = [...localIds].filter(id => !liveIds.has(id));

    if (onlyInLive.length) console.log('Only in live:', onlyInLive);
    if (onlyInLocal.length) console.log('Only in local:', onlyInLocal);

    expect(onlyInLive).toEqual([]);
    expect(onlyInLocal).toEqual([]);
  }, 30000);

  it('format definitions match structurally', async () => {
    const client = new CreativeAgentClient({
      agentUrl: STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE,
    });

    const liveFormats = await client.listFormats();
    const localFormats = buildReferenceFormats(TEST_AGENT_URL);

    const localByIdMap = new Map(
      localFormats.map(f => [(f.format_id as { id: string }).id, f]),
    );

    for (const live of liveFormats) {
      const local = localByIdMap.get(live.format_id.id);
      if (!local) continue;

      // Name should match
      expect(local.name, `name mismatch for ${live.format_id.id}`).toBe(live.name);

      // Asset count should match
      const liveAssets = (live as any).assets || [];
      const localAssets = (local as any).assets || [];
      expect(
        localAssets.length,
        `asset count mismatch for ${live.format_id.id}: live=${liveAssets.length}, local=${localAssets.length}`,
      ).toBe(liveAssets.length);

      // Render count should match
      const liveRenders = (live as any).renders || [];
      const localRenders = (local as any).renders || [];
      expect(
        localRenders.length,
        `render count mismatch for ${live.format_id.id}`,
      ).toBe(liveRenders.length);
    }
  }, 30000);

  it('list_creative_formats response structure matches', async () => {
    const client = new CreativeAgentClient({
      agentUrl: STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE,
    });

    const liveFormats = await client.listFormats();
    const localResult = handleListCreativeFormats({}, buildReferenceFormats(TEST_AGENT_URL));
    const localFormats = localResult.formats as Array<Record<string, unknown>>;

    // Both should return formats array
    expect(localFormats.length).toBe(liveFormats.length);

    // Check key structural fields exist on every local format
    for (const f of localFormats) {
      const fid = f.format_id as { agent_url: string; id: string };
      expect(fid.agent_url).toBeTruthy();
      expect(fid.id).toBeTruthy();
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
    }
  }, 30000);

  // ── preview_creative comparison ─────────────────────────────────────

  // Live agent expects dict-format assets with `url` for URL types
  const PREVIEW_TEST_FORMATS = [
    {
      id: 'display_300x250_image', label: 'display',
      // Dict format for live agent
      liveAssets: {
        banner_image: { asset_type: 'image', url: 'https://placehold.co/300x250' },
        click_url: { asset_type: 'url', url: 'https://example.com' },
      },
      // Array format for local agent
      localAssets: [
        { asset_id: 'banner_image', asset_type: 'image', url: 'https://placehold.co/300x250' },
        { asset_id: 'click_url', asset_type: 'url', url: 'https://example.com' },
      ],
    },
    {
      id: 'video_standard', label: 'video',
      liveAssets: {
        video_file: { asset_type: 'video', url: 'https://example.com/video.mp4' },
      },
      localAssets: [
        { asset_id: 'video_file', asset_type: 'video', url: 'https://example.com/video.mp4' },
      ],
    },
    {
      id: 'native_standard', label: 'native',
      liveAssets: {
        title: { asset_type: 'text', content: 'Test headline' },
        description: { asset_type: 'text', content: 'Test description' },
        main_image: { asset_type: 'image', url: 'https://placehold.co/600x400' },
        cta_text: { asset_type: 'text', content: 'Learn more' },
        sponsored_by: { asset_type: 'text', content: 'Acme Corp' },
      },
      localAssets: [
        { asset_id: 'title', asset_type: 'text', text: 'Test headline' },
        { asset_id: 'description', asset_type: 'text', text: 'Test description' },
        { asset_id: 'main_image', asset_type: 'image', url: 'https://placehold.co/600x400' },
        { asset_id: 'cta_text', asset_type: 'text', text: 'Learn more' },
        { asset_id: 'sponsored_by', asset_type: 'text', text: 'Acme Corp' },
      ],
    },
  ];

  for (const { id, label, liveAssets, localAssets } of PREVIEW_TEST_FORMATS) {
    it(`preview_creative response structure matches for ${label} (${id})`, async () => {
      // Call live agent with dict-format assets
      const liveFormatId = { agent_url: LIVE_AGENT_URL, id };
      const liveData = await callLiveTool('preview_creative', {
        format_id: liveFormatId,
        creative_manifest: {
          creative_id: `test_${id}`,
          format_id: liveFormatId,
          assets: liveAssets,
        },
        output_format: 'html',
      });

      // Call local agent with array-format assets
      const localFormatId = { agent_url: TEST_AGENT_URL, id };
      const formats = buildReferenceFormats(TEST_AGENT_URL);
      const localResult = handlePreviewCreative(
        {
          creative_manifest: {
            creative_id: `test_${id}`,
            format_id: localFormatId,
            assets: localAssets,
          },
          format_id: localFormatId,
          output_format: 'html',
        },
        formats,
        TEST_AGENT_URL,
      );

      // Both should return single response type
      expect(localResult.response_type, `${id}: response_type`).toBe('single');
      expect(liveData.response_type, `${id}: live response_type`).toBe('single');

      // Both should have previews array with at least one preview
      const livePreviews = liveData?.previews || [];
      const localPreviews = (localResult as any).previews || [];
      expect(livePreviews.length, `${id}: live has previews`).toBeGreaterThan(0);
      expect(localPreviews.length, `${id}: local has previews`).toBeGreaterThan(0);

      // Compare first preview's render structure
      const liveRender = livePreviews[0]?.renders?.[0];
      const localRender = localPreviews[0]?.renders?.[0];

      expect(liveRender, `${id}: live has render`).toBeTruthy();
      expect(localRender, `${id}: local has render`).toBeTruthy();

      // Both should have HTML content
      expect(liveRender.preview_html, `${id}: live has html`).toBeTruthy();
      expect(localRender.preview_html, `${id}: local has html`).toBeTruthy();

      // Dimensions should match
      if (liveRender.dimensions) {
        expect(localRender.dimensions?.width, `${id}: width`).toBe(liveRender.dimensions.width);
        expect(localRender.dimensions?.height, `${id}: height`).toBe(liveRender.dimensions.height);
      }

      // Both should have expires_at
      expect(liveData.expires_at, `${id}: live expires_at`).toBeTruthy();
      expect((localResult as any).expires_at, `${id}: local expires_at`).toBeTruthy();
    }, 30000);
  }

  it('preview_creative batch mode structure matches', async () => {
    const liveRequests = PREVIEW_TEST_FORMATS.map(({ id, liveAssets }) => ({
      format_id: { agent_url: LIVE_AGENT_URL, id },
      creative_manifest: {
        creative_id: `batch_${id}`,
        format_id: { agent_url: LIVE_AGENT_URL, id },
        assets: liveAssets,
      },
      output_format: 'html',
    }));

    const liveData = await callLiveTool('preview_creative', { requests: liveRequests });

    const localRequests = PREVIEW_TEST_FORMATS.map(({ id, localAssets }) => ({
      format_id: { agent_url: TEST_AGENT_URL, id },
      creative_manifest: {
        creative_id: `batch_${id}`,
        format_id: { agent_url: TEST_AGENT_URL, id },
        assets: localAssets,
      },
      output_format: 'html',
    }));
    const formats = buildReferenceFormats(TEST_AGENT_URL);
    const localResult = handlePreviewCreative(
      { request_type: 'batch', requests: localRequests },
      formats,
      TEST_AGENT_URL,
    );

    expect(localResult.response_type).toBe('batch');
    expect(liveData.response_type).toBe('batch');

    const liveResults = liveData?.results || [];
    const localResults = (localResult as any).results || [];
    expect(localResults.length, 'batch result count').toBe(liveResults.length);

    for (let i = 0; i < liveResults.length; i++) {
      expect(localResults[i].success, `batch[${i}]: local success`).toBe(true);
      expect(liveResults[i].success, `batch[${i}]: live success`).toBe(true);

      // Both should have previews with HTML renders
      const localPreviews = localResults[i].response?.previews || [];
      const livePreviews = liveResults[i].response?.previews || [];
      expect(localPreviews.length, `batch[${i}]: has previews`).toBeGreaterThan(0);
      expect(livePreviews.length, `batch[${i}]: live has previews`).toBeGreaterThan(0);
    }
  }, 30000);
});
