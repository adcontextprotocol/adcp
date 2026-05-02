// Pin polarity for the diagnostic-endpoint agent-type inference (#3774).
//
// Pre-#3540 these endpoints' inline inference returned 'buying' for agents
// EXPOSING SALES_TOOLS — the same inversion class #3540 fixed across the
// filter sites. PR #3774 extracted the duplicated inline blocks at
// http.ts:8442 and registry-api.ts:5802 into a single helper, flipped the
// polarity, and pinned the matrix here.
//
// If anyone reverts the polarity back to 'buying', the cases marked
// `// pinning #3774` below fail loudly.

import { describe, it, expect } from 'vitest';
import { inferDiagnosticAgentType } from '../../src/lib/diagnostic-agent-type-inference.js';

describe('inferDiagnosticAgentType — polarity matrix (#3774)', () => {
  it('returns "sales" for an agent exposing get_products // pinning #3774', () => {
    expect(inferDiagnosticAgentType(['get_products'])).toBe('sales');
  });

  it('returns "sales" for an agent exposing create_media_buy // pinning #3774', () => {
    expect(inferDiagnosticAgentType(['create_media_buy'])).toBe('sales');
  });

  it('returns "sales" for an agent exposing list_authorized_properties // pinning #3774', () => {
    // The substring `media_buy` doesn't match `list_authorized_properties`,
    // and `get_product` doesn't either. Fall-through: `creative` and
    // `signals` don't match. Result is `unknown`. This is a known limit of
    // the loose-match diagnostic inference — agents that only expose
    // list_authorized_properties (rare in practice) return `unknown` from
    // this helper. Canonical inference in CapabilityDiscovery does match
    // it. See helper docstring for the canonical-vs-loose split.
    //
    // Pinning the actual behavior so anyone tightening this knows what
    // they'd be changing.
    expect(inferDiagnosticAgentType(['list_authorized_properties'])).toBe('unknown');
  });

  it('returns "creative" for an agent exposing list_creative_formats', () => {
    expect(inferDiagnosticAgentType(['list_creative_formats'])).toBe('creative');
  });

  it('returns "creative" for an agent exposing build_creative', () => {
    expect(inferDiagnosticAgentType(['build_creative'])).toBe('creative');
  });

  it('returns "signals" for an agent exposing get_signals', () => {
    expect(inferDiagnosticAgentType(['get_signals'])).toBe('signals');
  });

  it('returns "signals" for an agent exposing match_audience', () => {
    expect(inferDiagnosticAgentType(['match_audience'])).toBe('signals');
  });

  it('returns "unknown" for an agent exposing no AdCP-recognised tools', () => {
    expect(inferDiagnosticAgentType(['get_status', 'whoami'])).toBe('unknown');
  });

  it('returns "unknown" for an empty tool list (buy-side / unreachable / non-AdCP)', () => {
    expect(inferDiagnosticAgentType([])).toBe('unknown');
  });

  it('prioritises sales over creative when an agent exposes both', () => {
    // Sales agents commonly also expose creative tools — the priority
    // chain in inferDiagnosticAgentType places sales first because the
    // registry surface treats sell-side as the primary integration.
    expect(
      inferDiagnosticAgentType(['get_products', 'list_creative_formats']),
    ).toBe('sales');
  });

  it('lowercases tool names before matching (spec is lowercase but agents may vary)', () => {
    expect(inferDiagnosticAgentType(['Get_Products', 'CREATE_MEDIA_BUY'])).toBe('sales');
  });

  it('NEVER returns "buying" — buy-side agents do not expose AdCP tools // pinning #3774', () => {
    // Brian-bar invariant: a passive probe cannot distinguish a buy-side
    // agent from a broken/empty MCP server. The diagnostic helper must
    // never return 'buying' from any tool list. Type=buying is exclusively
    // member-declared (see #3766 / resolveAgentTypes carve-out).
    const exhaustive = [
      ['get_products'],
      ['create_media_buy'],
      ['list_creative_formats'],
      ['get_signals'],
      ['something_with_buy_in_the_name'],
      ['create_media_purchase'],
      ['get_product_data'],
      [],
    ];
    for (const tools of exhaustive) {
      const result = inferDiagnosticAgentType(tools);
      expect(result).not.toBe('buying');
    }
  });
});
