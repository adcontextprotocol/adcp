import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AgentInventoryProfilesDatabase, type ProfileUpsertInput } from '../../src/db/agent-inventory-profiles-db.js';
import type { Pool } from 'pg';

/**
 * Shared test fixture: 5 agent profiles with known characteristics.
 * Used by both this integration test and the client-side AgentIndex unit test
 * to validate that server SQL and client JS produce the same ordering.
 */
const TEST_PROFILES: ProfileUpsertInput[] = [
  {
    agent_url: 'https://agent-a.example.com', // CTV + US + IAB-7, 100 props, TMP
    channels: ['ctv', 'olv'],
    property_types: ['ctv_app'],
    markets: ['US', 'CA'],
    categories: ['IAB-7', 'IAB-7-1'],
    tags: ['premium'],
    delivery_types: ['direct'],
    property_count: 100,
    publisher_count: 5,
    has_tmp: true,
  },
  {
    agent_url: 'https://agent-b.example.com', // CTV + US, 10 props, TMP
    channels: ['ctv'],
    property_types: ['ctv_app'],
    markets: ['US'],
    categories: ['IAB-7'],
    tags: [],
    delivery_types: ['direct'],
    property_count: 10,
    publisher_count: 2,
    has_tmp: true,
  },
  {
    agent_url: 'https://agent-c.example.com', // Display + US + IAB-7, 200 props, no TMP
    channels: ['display'],
    property_types: ['website'],
    markets: ['US', 'UK'],
    categories: ['IAB-7', 'IAB-12'],
    tags: ['news', 'premium'],
    delivery_types: ['direct', 'delegated'],
    property_count: 200,
    publisher_count: 15,
    has_tmp: false,
  },
  {
    agent_url: 'https://agent-d.example.com', // Audio + global, 30 props, no TMP
    channels: ['audio'],
    property_types: ['podcast', 'audio_stream'],
    markets: ['US', 'UK', 'DE', 'FR'],
    categories: ['IAB-1'],
    tags: ['music', 'podcast'],
    delivery_types: ['ad_network'],
    property_count: 30,
    publisher_count: 8,
    has_tmp: false,
  },
  {
    agent_url: 'https://agent-e.example.com', // CTV + UK, 5 props, no TMP
    channels: ['ctv'],
    property_types: ['ctv_app'],
    markets: ['UK'],
    categories: ['IAB-7'],
    tags: [],
    delivery_types: ['delegated'],
    property_count: 5,
    publisher_count: 1,
    has_tmp: false,
  },
];

describe('Registry Search Integration Tests', () => {
  let pool: Pool;
  let profilesDb: AgentInventoryProfilesDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    profilesDb = new AgentInventoryProfilesDatabase();

    // Insert parent discovered_agents rows (FK constraint)
    for (const p of TEST_PROFILES) {
      await pool.query(
        `INSERT INTO discovered_agents (agent_url, source_type, source_domain)
         VALUES ($1, 'adagents_json', 'test.example.com')
         ON CONFLICT (agent_url) DO NOTHING`,
        [p.agent_url]
      );
    }
  });

  afterAll(async () => {
    // Clean up in reverse FK order
    for (const p of TEST_PROFILES) {
      await pool.query('DELETE FROM agent_inventory_profiles WHERE agent_url = $1', [p.agent_url]);
      await pool.query('DELETE FROM discovered_agents WHERE agent_url = $1', [p.agent_url]);
    }
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM agent_inventory_profiles');
    for (const p of TEST_PROFILES) {
      await profilesDb.upsertProfile(p);
    }
  });

  // ── Single Filter Overlap ────────────────────────────────────────

  describe('single filter overlap', () => {
    it('returns CTV agents for channels=ctv', async () => {
      const result = await profilesDb.search({ channels: ['ctv'] });
      const urls = result.results.map(r => r.agent_url);
      expect(urls).toContain('https://agent-a.example.com');
      expect(urls).toContain('https://agent-b.example.com');
      expect(urls).toContain('https://agent-e.example.com');
      expect(urls).not.toContain('https://agent-c.example.com'); // display only
      expect(urls).not.toContain('https://agent-d.example.com'); // audio only
    });

    it('returns US agents for markets=US', async () => {
      const result = await profilesDb.search({ markets: ['US'] });
      const urls = result.results.map(r => r.agent_url);
      expect(urls).toContain('https://agent-a.example.com');
      expect(urls).toContain('https://agent-b.example.com');
      expect(urls).toContain('https://agent-c.example.com');
      expect(urls).toContain('https://agent-d.example.com');
      expect(urls).not.toContain('https://agent-e.example.com'); // UK only
    });

    it('handles OR within dimension: channels=ctv,audio', async () => {
      const result = await profilesDb.search({ channels: ['ctv', 'audio'] });
      expect(result.results).toHaveLength(4); // 3 ctv + 1 audio
    });
  });

  // ── Multi-Filter AND ─────────────────────────────────────────────

  describe('multi-filter AND', () => {
    it('narrows results: channels=ctv AND markets=US', async () => {
      const result = await profilesDb.search({ channels: ['ctv'], markets: ['US'] });
      const urls = result.results.map(r => r.agent_url);
      expect(urls).toContain('https://agent-a.example.com');
      expect(urls).toContain('https://agent-b.example.com');
      expect(urls).not.toContain('https://agent-e.example.com'); // ctv but UK only
    });

    it('narrows further: channels=ctv AND markets=US AND categories=IAB-7', async () => {
      const result = await profilesDb.search({
        channels: ['ctv'],
        markets: ['US'],
        categories: ['IAB-7'],
      });
      const urls = result.results.map(r => r.agent_url);
      expect(urls).toContain('https://agent-a.example.com');
      expect(urls).toContain('https://agent-b.example.com');
      expect(urls).not.toContain('https://agent-e.example.com');
    });

    it('returns empty when no agents match all filters', async () => {
      const result = await profilesDb.search({
        channels: ['audio'],
        markets: ['JP'],
      });
      expect(result.results).toHaveLength(0);
    });
  });

  // ── Relevance Ordering ──────────────────────────────────────────

  describe('relevance ordering', () => {
    it('ranks by property depth (inventory tiebreak)', async () => {
      // Both CTV + US, but agent-a has 100 props vs agent-b 10 props
      const result = await profilesDb.search({ channels: ['ctv'], markets: ['US'] });
      const urls = result.results.map(r => r.agent_url);
      const idxA = urls.indexOf('https://agent-a.example.com');
      const idxB = urls.indexOf('https://agent-b.example.com');
      expect(idxA).toBeLessThan(idxB); // A ranks higher
    });

    it('TMP boost helps ranking', async () => {
      // agent-a (CTV, US, TMP, 100 props) vs agent-e (CTV, UK, no TMP, 5 props)
      // Search for just channels=ctv — both match
      const result = await profilesDb.search({ channels: ['ctv'] });
      const a = result.results.find(r => r.agent_url === 'https://agent-a.example.com');
      const e = result.results.find(r => r.agent_url === 'https://agent-e.example.com');
      expect(a!.relevance_score).toBeGreaterThan(e!.relevance_score);
    });

    it('matched_filters tracks which dimensions matched', async () => {
      const result = await profilesDb.search({
        channels: ['ctv'],
        markets: ['US'],
        categories: ['IAB-7'],
      });
      const agentA = result.results.find(r => r.agent_url === 'https://agent-a.example.com');
      expect(agentA!.matched_filters).toContain('channels');
      expect(agentA!.matched_filters).toContain('markets');
      expect(agentA!.matched_filters).toContain('categories');
    });
  });

  // ── Boolean and Numeric Filters ─────────────────────────────────

  describe('boolean and numeric filters', () => {
    it('filters by has_tmp=true', async () => {
      const result = await profilesDb.search({ has_tmp: true });
      expect(result.results.every(r => r.has_tmp)).toBe(true);
      expect(result.results).toHaveLength(2); // agent-a, agent-b
    });

    it('filters by min_properties', async () => {
      const result = await profilesDb.search({ min_properties: 50 });
      expect(result.results.every(r => r.property_count >= 50)).toBe(true);
      expect(result.results.map(r => r.agent_url)).not.toContain('https://agent-e.example.com'); // 5 props
    });
  });

  // ── Cursor Pagination ───────────────────────────────────────────

  describe('cursor pagination', () => {
    it('paginates through results', async () => {
      const page1 = await profilesDb.search({ limit: 2 });
      expect(page1.results).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeTruthy();

      const page2 = await profilesDb.search({ limit: 2, cursor: page1.cursor! });
      expect(page2.results).toHaveLength(2);

      const page3 = await profilesDb.search({ limit: 2, cursor: page2.cursor! });
      expect(page3.results).toHaveLength(1);
      expect(page3.has_more).toBe(false);

      // All 5 agents across 3 pages, no duplicates
      const allUrls = [
        ...page1.results.map(r => r.agent_url),
        ...page2.results.map(r => r.agent_url),
        ...page3.results.map(r => r.agent_url),
      ];
      expect(new Set(allUrls).size).toBe(5);
    });
  });

  // ── Upsert Idempotency ─────────────────────────────────────────

  describe('upsert idempotency', () => {
    it('upserting same profile twice does not create duplicate', async () => {
      await profilesDb.upsertProfile(TEST_PROFILES[0]);
      await profilesDb.upsertProfile(TEST_PROFILES[0]);

      const result = await profilesDb.search({ channels: ['ctv'] });
      const countA = result.results.filter(r => r.agent_url === 'https://agent-a.example.com').length;
      expect(countA).toBe(1);
    });
  });

  // ── No Filters ──────────────────────────────────────────────────

  describe('no filters', () => {
    it('returns all profiles ranked by depth when no filters', async () => {
      const result = await profilesDb.search({});
      expect(result.results).toHaveLength(5);
      // Without filter dimensions, score is just depth + TMP boost
      // agent-c (200 props, no TMP) should rank high due to depth
      expect(result.results[0].agent_url).toBe('https://agent-c.example.com');
    });
  });
});
