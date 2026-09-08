import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const agentsHtml = readFileSync(new URL('../../public/agents.html', import.meta.url), 'utf8');

describe('public agent registry UI', () => {
  it('uses the public discovery proxy routes instead of the removed MCP helpers', () => {
    expect(agentsHtml).toContain('/api/public/agent-products?url=');
    expect(agentsHtml).toContain('/api/public/agent-formats?url=');
    expect(agentsHtml).toContain('/v1/agents/${encodeURIComponent(agent.url)}/publishers?status=authorized&status=revoked&limit=1000');
    expect(agentsHtml).not.toContain('/api/public/agent-publishers?url=');
    expect(agentsHtml).not.toContain("fetch(`/mcp`");
  });

  it('renders indexed publisher authorization records and handles non-JSON responses', () => {
    expect(agentsHtml).toContain('const raw = await response.text()');
    expect(agentsHtml).toContain('data = JSON.parse(raw)');
    expect(agentsHtml).toContain('p.publisher_domain');
    expect(agentsHtml).toContain('p.properties_authorized');
    expect(agentsHtml).toContain('response.status === 404');
    expect(agentsHtml).toContain('if (data.next_cursor)');
    expect(agentsHtml).toContain('Showing the first 1,000 publisher authorizations');
  });

  it('renders the complete discovered tool catalog count', () => {
    expect(agentsHtml).toContain('agent?.capabilities?.tools_count ?? agent?.health?.tools_count');
    expect(agentsHtml).toContain('agentWithCaps?.capabilities?.tools || []');
    expect(agentsHtml).toContain('&middot; ${agentToolCount(agentWithCaps)} tools');
    expect(agentsHtml).not.toContain('${coreImplemented.length + optionalImplemented.length} tools');
  });

  it('allowlists verification links and escapes responsive format dimensions', () => {
    expect(agentsHtml).toContain("parsed.protocol === 'https:'");
    expect(agentsHtml).not.toContain('href="${escapeHtml(p.verification_url)}"');
    expect(agentsHtml).toContain('escapeHtml(String(params.min_width || 0))');
  });
});
