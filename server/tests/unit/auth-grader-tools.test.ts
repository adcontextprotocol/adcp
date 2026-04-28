import { describe, it, expect } from 'vitest';
import {
  AUTH_GRADER_TOOLS,
  createAuthGraderToolHandlers,
} from '../../src/addie/mcp/auth-grader-tools.js';

describe('auth grader tools', () => {
  it('registers exactly two tools — grade_agent_signing and diagnose_agent_auth', () => {
    const names = AUTH_GRADER_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['diagnose_agent_auth', 'grade_agent_signing']);
  });

  it('declares allow_live_side_effects as opt-in (not required)', () => {
    const grader = AUTH_GRADER_TOOLS.find((t) => t.name === 'grade_agent_signing');
    expect(grader).toBeDefined();
    expect(grader!.input_schema.required).toEqual(['agent_url']);
    const props = grader!.input_schema.properties as Record<string, unknown>;
    expect(props.allow_live_side_effects).toBeDefined();
    expect(props.allow_http).toBeDefined();
  });

  it('rejects malformed agent URLs without invoking the grader', async () => {
    const handlers = createAuthGraderToolHandlers();
    const grader = handlers.get('grade_agent_signing')!;
    const out = await grader({ agent_url: 'not-a-url' });
    expect(out).toContain('Invalid agent URL');
  });

  it('rejects cloud-metadata SSRF targets', async () => {
    const handlers = createAuthGraderToolHandlers();
    const diag = handlers.get('diagnose_agent_auth')!;
    const out = await diag({ agent_url: 'http://169.254.169.254/' });
    expect(out).toContain('blocked');
  });

  it('rejects non-http(s) protocols', async () => {
    const handlers = createAuthGraderToolHandlers();
    const grader = handlers.get('grade_agent_signing')!;
    const out = await grader({ agent_url: 'file:///etc/passwd' });
    expect(out).toContain('HTTP or HTTPS');
  });
});
