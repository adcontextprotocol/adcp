/**
 * Smoke test: evaluate_agent_quality and compare_media_kit tools
 *
 * Tests the tool handlers directly by importing them.
 * The tools call comply() from @adcp/client which hits the training agent over HTTP,
 * so the local server must be running.
 *
 * Requires: local server running on localhost:55020
 * Run: npx tsx server/tests/smoke/agent-testing-tools.ts
 */

import { createMemberToolHandlers } from '../../src/addie/mcp/member-tools.js';
import type { MemberContext } from '../../src/addie/member-context.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:55020';
const TEST_AGENT_URL = `${BASE_URL}/api/training-agent/mcp`;

// Minimal member context — the tools only need this for auth resolution
const mockMemberContext: MemberContext = {
  workos_user: {
    workos_user_id: 'smoke-test-user',
    email: 'smoke@test.local',
    first_name: 'Smoke',
    last_name: 'Test',
  },
  organization: null,
  member_profile: null,
  conversation_id: 'smoke-test',
  thread_id: null,
  relationship: null,
};

// ─── Sample media kits ───

const MEDIA_KITS = {
  premium_publisher: {
    name: 'Premium News Publisher',
    summary:
      'Major news publisher with 50M monthly uniques. Offers display (standard IAB, high-impact), video (pre-roll, mid-roll, outstream), native content studio, and podcast sponsorships across news, politics, business, and lifestyle verticals. Premium programmatic via PMP and PG deals. First-party audience segments from registration data.',
    verticals: ['news', 'business', 'lifestyle'],
    channels: ['display', 'video', 'native', 'podcast'],
    formats: ['728x90', '300x250', '970x250', 'pre-roll', 'mid-roll', 'outstream', 'native-article'],
    platform_type: 'display_ad_server',
  },

  ctv_streamer: {
    name: 'CTV Streaming Platform',
    summary:
      'Ad-supported streaming service with 8M MAU. Offers 15s and 30s non-skippable pre-roll and mid-roll on CTV, mobile, and desktop. Audience targeting via ACR data and content genre. CPM pricing with frequency caps. Measurement via Nielsen DAR and Comscore.',
    verticals: ['entertainment', 'automotive', 'cpg'],
    channels: ['ctv', 'olv'],
    formats: ['15s-video', '30s-video', 'pause-screen'],
    platform_type: 'video_ad_server',
  },

  retail_media_network: {
    name: 'Grocery Retail Media Network',
    summary:
      'Top-10 grocery chain with 2,000 stores and 15M loyalty members. Offers on-site sponsored products, display on .com and app, in-store digital screens (endcap, checkout), and offsite retargeting via loyalty data. Closed-loop measurement from ad exposure to purchase.',
    verticals: ['cpg', 'food_beverage', 'healthcare'],
    channels: ['retail_media', 'display', 'dooh'],
    formats: ['sponsored-product', 'display-banner', 'endcap-screen', 'checkout-screen'],
    platform_type: 'retail_media',
  },

  audio_publisher: {
    name: 'Podcast & Audio Network',
    summary:
      'Top podcast network with 200 shows and 80M monthly downloads. Offers host-read sponsorships, dynamically inserted audio ads (pre-roll, mid-roll), and companion display. Targeting by show, genre, geography, and listener demographics. Measured via Podtrac and Chartable.',
    verticals: ['technology', 'business', 'health_wellness'],
    channels: ['podcast', 'streaming_audio'],
    formats: ['host-read-60s', 'host-read-30s', 'dynamic-15s', 'dynamic-30s', 'companion-display'],
    platform_type: 'audio_platform',
  },

  small_local: {
    name: 'Local News Group',
    summary:
      'Regional news group covering 3 mid-size markets. Display ads on desktop and mobile web. Email newsletter sponsorships (45K subscribers). Limited programmatic — mostly direct sold. Verticals: local business, real estate, automotive, dining.',
    verticals: ['automotive', 'real_estate'],
    channels: ['display', 'newsletter'],
    formats: ['300x250', '728x90', 'newsletter-banner'],
  },
};

// ─── Test runner ───

function separator(title: string) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

function truncate(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (${s.length} chars total)`;
}

async function main() {
  console.log(`Test agent: ${TEST_AGENT_URL}`);

  // Health check
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json() as { status: string };
    if (data.status !== 'ok') throw new Error('unhealthy');
    console.log('Server healthy ✓\n');
  } catch {
    console.error(`Cannot reach server at ${BASE_URL}. Is it running?`);
    process.exit(1);
  }

  const handlers = createMemberToolHandlers(mockMemberContext);

  // ─── evaluate_agent_quality ───

  separator('evaluate_agent_quality — basic');
  const basic = await handlers.get('evaluate_agent_quality')!({
    agent_url: TEST_AGENT_URL,
  });
  console.log(truncate(basic));

  separator('evaluate_agent_quality — platform_type: display_ad_server');
  const display = await handlers.get('evaluate_agent_quality')!({
    agent_url: TEST_AGENT_URL,
    platform_type: 'display_ad_server',
  });
  console.log(truncate(display));

  separator('evaluate_agent_quality — platform_type: retail_media');
  const retail = await handlers.get('evaluate_agent_quality')!({
    agent_url: TEST_AGENT_URL,
    platform_type: 'retail_media',
  });
  console.log(truncate(retail));

  separator('evaluate_agent_quality — specific tracks');
  const tracks = await handlers.get('evaluate_agent_quality')!({
    agent_url: TEST_AGENT_URL,
    tracks: ['core', 'products', 'creative'],
  });
  console.log(truncate(tracks));

  // ─── compare_media_kit ───

  for (const [key, kit] of Object.entries(MEDIA_KITS)) {
    separator(`compare_media_kit — ${kit.name}`);
    const result = await handlers.get('compare_media_kit')!({
      agent_url: TEST_AGENT_URL,
      media_kit_summary: kit.summary,
      verticals: kit.verticals,
      channels: kit.channels,
      formats: kit.formats,
      ...('platform_type' in kit ? { platform_type: kit.platform_type } : {}),
    });
    console.log(truncate(result, 1500));
  }

  // ─── test_adcp_agent (deprecated delegate) ───

  separator('test_adcp_agent — deprecated delegate');
  const deprecated = await handlers.get('test_adcp_agent')!({
    agent_url: TEST_AGENT_URL,
  });
  // Just verify it returns the same structure as evaluate_agent_quality
  const hasQualityHeader = deprecated.includes('Quality Evaluation');
  console.log(`Delegates correctly: ${hasQualityHeader ? '✓' : '✗'}`);
  if (!hasQualityHeader) {
    console.log('Response:', truncate(deprecated, 500));
  }

  separator('All smoke tests complete');
}

main().catch((e) => {
  console.error('Smoke test failed:', e);
  process.exit(1);
});
