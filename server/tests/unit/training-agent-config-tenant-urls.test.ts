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

  it('emits proactive per-tool routing table for multi-tenant modules', () => {
    const block = formatTenantBlock(
      tenantUrlsForModule(['brand', 'governance', 'creative'], BASE),
    );
    // Primary URL must lead.
    expect(block).toContain(`agent_url (primary): "${BASE}/brand/mcp"`);
    // Block must be tagged as agent-only context.
    expect(block).toContain('Internal — do not narrate to the learner');
    // Must contain per-tool routing, not a reactive sibling-switch.
    expect(block).toContain('Tool routing:');
    expect(block).toContain(`${BASE}/brand/mcp`);
    expect(block).toContain(`${BASE}/governance/mcp`);
    expect(block).toContain(`${BASE}/creative/mcp`);
    // Tools must be routed to the correct tenant URL.
    expect(block).toContain('search_brands');
    expect(block).toContain('check_governance');
    expect(block).toContain('sync_creatives');
    // No reactive fallback instructions.
    expect(block).not.toContain('unknown tool');
    expect(block).not.toContain('/.well-known/adagents.json');
  });

  it('routes si_* tools to the /si tenant for C3-style modules', () => {
    const block = formatTenantBlock(
      tenantUrlsForModule(['creative', 'si'], BASE),
    );
    expect(block).toContain(`agent_url (primary): "${BASE}/creative/mcp"`);
    // SI tools must route to /si, not primary.
    expect(block).toContain(`${BASE}/si/mcp`);
    expect(block).toContain('si_initiate_session');
    expect(block).toContain('si_send_message');
    // si_* tools must NOT appear on the primary creative line
    const lines = block.split('\n');
    const creativeLine = lines.find(l => l.includes(`${BASE}/creative/mcp`));
    expect(creativeLine).not.toContain('si_initiate_session');
  });
});
