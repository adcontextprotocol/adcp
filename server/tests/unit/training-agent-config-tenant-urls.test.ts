import { describe, it, expect } from 'vitest';
import { tenantUrlsForModule } from '../../src/training-agent/config.js';
import { formatTenantBlock } from '../../src/addie/mcp/certification-tools.js';

const BASE = 'https://test-agent.adcontextprotocol.org';

describe('tenantUrlsForModule', () => {
  it('returns the legacy /mcp alias when tenant_ids is null', () => {
    const t = tenantUrlsForModule(null, BASE);
    expect(t.ids).toEqual([]);
    expect(t.primary).toBe(`${BASE}/mcp`);
    expect(t.all).toEqual([`${BASE}/mcp`]);
  });

  it('returns the legacy /mcp alias when tenant_ids is empty', () => {
    const t = tenantUrlsForModule([], BASE);
    expect(t.ids).toEqual([]);
    expect(t.primary).toBe(`${BASE}/mcp`);
  });

  it('builds a per-tenant URL for a single-tenant module', () => {
    const t = tenantUrlsForModule(['signals'], BASE);
    expect(t.ids).toEqual(['signals']);
    expect(t.primary).toBe(`${BASE}/signals/mcp`);
    expect(t.all).toEqual([`${BASE}/signals/mcp`]);
  });

  it('preserves order — index 0 is primary, rest are siblings', () => {
    const t = tenantUrlsForModule(['brand', 'governance', 'creative'], BASE);
    expect(t.ids).toEqual(['brand', 'governance', 'creative']);
    expect(t.primary).toBe(`${BASE}/brand/mcp`);
    expect(t.all).toEqual([
      `${BASE}/brand/mcp`,
      `${BASE}/governance/mcp`,
      `${BASE}/creative/mcp`,
    ]);
  });

  it('strips a trailing slash on the base url', () => {
    const t = tenantUrlsForModule(['sales'], `${BASE}/`);
    expect(t.primary).toBe(`${BASE}/sales/mcp`);
  });

  it('handles hyphenated tenant ids (creative-builder)', () => {
    const t = tenantUrlsForModule(['creative-builder'], BASE);
    expect(t.primary).toBe(`${BASE}/creative-builder/mcp`);
  });
});

describe('formatTenantBlock', () => {
  it('collapses a single-tenant module to a one-liner', () => {
    const block = formatTenantBlock(tenantUrlsForModule(['signals'], BASE));
    expect(block).toBe(`agent_url: "${BASE}/signals/mcp"`);
  });

  it('collapses an empty pinning to the legacy /mcp alias', () => {
    const block = formatTenantBlock(tenantUrlsForModule(null, BASE));
    expect(block).toBe(`agent_url: "${BASE}/mcp"`);
  });

  it('emits primary + sibling list with internal-only framing for multi-tenant modules', () => {
    const block = formatTenantBlock(
      tenantUrlsForModule(['brand', 'governance', 'creative'], BASE),
    );
    // Primary URL must lead and every sibling must appear in declaration order.
    expect(block).toContain(`agent_url (primary): "${BASE}/brand/mcp"`);
    expect(block).toContain(`brand → ${BASE}/brand/mcp`);
    expect(block).toContain(`governance → ${BASE}/governance/mcp`);
    expect(block).toContain(`creative → ${BASE}/creative/mcp`);
    // Block must be tagged as agent-only context — without this Sage
    // paraphrases the URL list into the conversation.
    expect(block).toContain('Internal — do not narrate to the learner');
    // Switch trigger must be explicit + procedural, not aspirational.
    expect(block).toContain('unknown tool');
    expect(block).toContain('/.well-known/adagents.json');
    expect(block).toContain('_training_agent_tenants');
    expect(block).toContain('Do not enumerate siblings to the learner');
  });
});
