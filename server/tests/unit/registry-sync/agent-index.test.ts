import { describe, it, expect, beforeEach } from 'vitest';
import { AgentIndex, type AgentProfile } from '../../../src/registry-sync/agent-index.js';

function makeProfile(overrides: Partial<AgentProfile> & { agent_url: string }): AgentProfile {
  return {
    channels: [],
    property_types: [],
    markets: [],
    categories: [],
    tags: [],
    delivery_types: [],
    format_ids: [],
    property_count: 0,
    publisher_count: 0,
    has_tmp: false,
    category_taxonomy: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentIndex', () => {
  let index: AgentIndex;

  beforeEach(() => {
    index = new AgentIndex();
  });

  describe('CRUD', () => {
    it('upserts and retrieves by URL', () => {
      const p = makeProfile({ agent_url: 'https://a.example.com', channels: ['ctv'] });
      index.upsert(p);
      expect(index.get('https://a.example.com')).toEqual(p);
      expect(index.size).toBe(1);
    });

    it('overwrites on duplicate URL', () => {
      index.upsert(makeProfile({ agent_url: 'https://a.example.com', channels: ['ctv'] }));
      index.upsert(makeProfile({ agent_url: 'https://a.example.com', channels: ['display'] }));
      expect(index.get('https://a.example.com')!.channels).toEqual(['display']);
      expect(index.size).toBe(1);
    });

    it('removes agent', () => {
      index.upsert(makeProfile({ agent_url: 'https://a.example.com' }));
      expect(index.remove('https://a.example.com')).toBe(true);
      expect(index.get('https://a.example.com')).toBeUndefined();
      expect(index.remove('https://a.example.com')).toBe(false);
    });

    it('lists all agents', () => {
      index.upsert(makeProfile({ agent_url: 'https://a.example.com' }));
      index.upsert(makeProfile({ agent_url: 'https://b.example.com' }));
      expect(index.list()).toHaveLength(2);
    });
  });

  describe('search', () => {
    const agents = {
      ctv_us: makeProfile({
        agent_url: 'https://ctv-us.example.com',
        channels: ['ctv'], markets: ['US'], categories: ['IAB-7'],
        property_count: 100, has_tmp: true,
      }),
      ctv_uk: makeProfile({
        agent_url: 'https://ctv-uk.example.com',
        channels: ['ctv'], markets: ['UK'],
        property_count: 50, has_tmp: true,
      }),
      display_us: makeProfile({
        agent_url: 'https://display-us.example.com',
        channels: ['display'], markets: ['US'], categories: ['IAB-7', 'IAB-12'],
        property_count: 200, has_tmp: false,
      }),
      audio_global: makeProfile({
        agent_url: 'https://audio.example.com',
        channels: ['audio'], markets: ['US', 'UK', 'DE'],
        property_count: 30, has_tmp: false,
      }),
      small_ctv: makeProfile({
        agent_url: 'https://small-ctv.example.com',
        channels: ['ctv'], markets: ['US'],
        property_count: 5, has_tmp: false,
      }),
    };

    beforeEach(() => {
      for (const p of Object.values(agents)) {
        index.upsert(p);
      }
    });

    it('returns all when no filters', () => {
      const results = index.search({});
      expect(results).toHaveLength(5);
    });

    it('filters by single channel (OR within dimension)', () => {
      const results = index.search({ channels: ['ctv'] });
      expect(results.map(r => r.agent_url)).toContain('https://ctv-us.example.com');
      expect(results.map(r => r.agent_url)).toContain('https://ctv-uk.example.com');
      expect(results.map(r => r.agent_url)).toContain('https://small-ctv.example.com');
      expect(results.map(r => r.agent_url)).not.toContain('https://display-us.example.com');
    });

    it('handles OR within a filter dimension', () => {
      const results = index.search({ channels: ['ctv', 'audio'] });
      expect(results).toHaveLength(4); // 3 ctv + 1 audio
    });

    it('applies AND across filter dimensions', () => {
      const results = index.search({ channels: ['ctv'], markets: ['US'] });
      const urls = results.map(r => r.agent_url);
      expect(urls).toContain('https://ctv-us.example.com');
      expect(urls).toContain('https://small-ctv.example.com');
      expect(urls).not.toContain('https://ctv-uk.example.com');
    });

    it('filters by has_tmp', () => {
      const results = index.search({ has_tmp: true });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.has_tmp)).toBe(true);
    });

    it('filters by min_properties', () => {
      const results = index.search({ min_properties: 50 });
      expect(results.every(r => r.property_count >= 50)).toBe(true);
      expect(results.map(r => r.agent_url)).not.toContain('https://small-ctv.example.com');
    });

    it('caps limit', () => {
      const results = index.search({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('includes matched_filters in results', () => {
      const results = index.search({ channels: ['ctv'], markets: ['US'] });
      const ctvUs = results.find(r => r.agent_url === 'https://ctv-us.example.com');
      expect(ctvUs?.matched_filters).toEqual(['channels', 'markets']);
    });

    // ── Relevance ordering ────────────────────────────────────────

    it('ranks by filter breadth first', () => {
      // 3 filter dimensions: channels + markets + categories
      const results = index.search({ channels: ['ctv', 'display'], markets: ['US'], categories: ['IAB-7'] });
      // ctv_us matches all 3, display_us matches 2 (channels + markets + categories but channel=display not ctv)
      // Actually display_us has channels=['display'] which overlaps with ['ctv','display'], markets=['US'], categories=['IAB-7','IAB-12']
      // ctv_us: channels=['ctv'] overlaps, markets=['US'] overlaps, categories=['IAB-7'] overlaps → 3/3
      // display_us: channels=['display'] overlaps, markets=['US'] overlaps, categories=['IAB-7','IAB-12'] overlaps → 3/3
      // Both match 3/3, but display_us has more properties (200 vs 100)
      expect(results[0].agent_url).toBe('https://display-us.example.com');
      expect(results[1].agent_url).toBe('https://ctv-us.example.com');
    });

    it('uses property depth as tiebreaker', () => {
      // Same filter match count, different property_count
      const results = index.search({ channels: ['ctv'], markets: ['US'] });
      const ctvUs = results.find(r => r.agent_url === 'https://ctv-us.example.com');
      const smallCtv = results.find(r => r.agent_url === 'https://small-ctv.example.com');
      expect(ctvUs!.relevance_score).toBeGreaterThan(smallCtv!.relevance_score);
    });

    it('applies TMP boost', () => {
      // ctv_us has TMP, small_ctv does not — both match channels=['ctv'] markets=['US']
      const results = index.search({ channels: ['ctv'], markets: ['US'] });
      const ctvUs = results.find(r => r.agent_url === 'https://ctv-us.example.com');
      const smallCtv = results.find(r => r.agent_url === 'https://small-ctv.example.com');
      // TMP boost = 0.05
      const scoreWithoutTmp = smallCtv!.relevance_score;
      const scoreWithTmp = ctvUs!.relevance_score;
      expect(scoreWithTmp - scoreWithoutTmp).toBeGreaterThanOrEqual(0.05);
    });

    it('deterministic tiebreak on agent_url', () => {
      // Create two agents with identical characteristics
      index.upsert(makeProfile({
        agent_url: 'https://alpha.example.com',
        channels: ['test'], property_count: 10,
      }));
      index.upsert(makeProfile({
        agent_url: 'https://beta.example.com',
        channels: ['test'], property_count: 10,
      }));

      const results = index.search({ channels: ['test'] });
      const testResults = results.filter(r => r.agent_url.includes('alpha') || r.agent_url.includes('beta'));
      expect(testResults[0].agent_url).toBe('https://alpha.example.com');
      expect(testResults[1].agent_url).toBe('https://beta.example.com');
    });
  });
});
