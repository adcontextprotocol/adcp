import { describe, it, expect } from 'vitest';
import {
  AUTH_GRADER_TOOLS,
  createAuthGraderToolHandlers,
  contentDigestSkipsForMode,
} from '../../src/addie/mcp/auth-grader-tools.js';

describe('auth grader tools', () => {
  it('registers exactly two tools — grade_agent_signing and diagnose_agent_auth', () => {
    const names = AUTH_GRADER_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['diagnose_agent_auth', 'grade_agent_signing']);
  });

  it('does not expose hosted private-network or live-side-effect escape hatches', () => {
    const grader = AUTH_GRADER_TOOLS.find((t) => t.name === 'grade_agent_signing');
    const diagnosis = AUTH_GRADER_TOOLS.find((t) => t.name === 'diagnose_agent_auth');
    expect(grader).toBeDefined();
    expect(grader!.input_schema.required).toEqual(['agent_url']);
    const props = grader!.input_schema.properties as Record<string, unknown>;
    const diagnosisProps = diagnosis!.input_schema.properties as Record<string, unknown>;
    expect(props.allow_live_side_effects).toBeUndefined();
    expect(props.allow_http).toBeUndefined();
    expect(diagnosisProps.allow_http).toBeUndefined();
  });

  it('exposes transport mcp/raw with mcp default (the schema declares enum, handler defaults absent → mcp)', () => {
    const grader = AUTH_GRADER_TOOLS.find((t) => t.name === 'grade_agent_signing');
    const props = grader!.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.transport).toBeDefined();
    expect(props.transport.enum).toEqual(['mcp', 'raw']);
    // transport is NOT in `required` — handler treats absence as mcp.
    expect(grader!.input_schema.required).not.toContain('transport');
  });

  it('rejects malformed agent URLs without invoking the grader', async () => {
    const handlers = createAuthGraderToolHandlers('system:addie');
    const grader = handlers.get('grade_agent_signing')!;
    const out = await grader({ agent_url: 'not-a-url' });
    expect(out).toContain('Invalid agent URL');
  });

  it('rejects cloud-metadata SSRF targets', async () => {
    const handlers = createAuthGraderToolHandlers('system:addie');
    const diag = handlers.get('diagnose_agent_auth')!;
    const out = await diag({ agent_url: 'https://169.254.169.254/' });
    expect(out).toContain('public network');
  });

  it('rejects non-http(s) protocols', async () => {
    const handlers = createAuthGraderToolHandlers('system:addie');
    const grader = handlers.get('grade_agent_signing')!;
    const out = await grader({ agent_url: 'file:///etc/passwd' });
    expect(out).toContain('public HTTPS');
  });

  it('requires a stable nonempty caller ID', () => {
    expect(() => createAuthGraderToolHandlers('')).toThrow(/stable caller ID/);
    expect(() => createAuthGraderToolHandlers('   ')).toThrow(/stable caller ID/);
  });
});

describe('contentDigestSkipsForMode', () => {
  it('returns no skips when mode is null (probe failed)', () => {
    // Probe failure must NOT swallow real verifier bugs — better to over-report.
    expect(contentDigestSkipsForMode(null)).toEqual([]);
  });

  it("'either' mode skips both 007 and 018", () => {
    // Agent declares it accepts signatures with or without content-digest;
    // both forced-mode vectors (required + forbidden) are inapplicable.
    expect(contentDigestSkipsForMode('either').sort()).toEqual([
      '007-missing-content-digest',
      '018-digest-covered-when-forbidden',
    ]);
  });

  it("'required' mode skips only 018 (digest-when-forbidden)", () => {
    // Agent requires content-digest coverage; the negative vector that
    // tests forbidden-mode rejection doesn't apply.
    expect(contentDigestSkipsForMode('required')).toEqual([
      '018-digest-covered-when-forbidden',
    ]);
  });

  it("'forbidden' mode skips only 007 (missing-content-digest)", () => {
    // Agent forbids content-digest coverage; the negative vector that
    // tests required-mode rejection doesn't apply.
    expect(contentDigestSkipsForMode('forbidden')).toEqual([
      '007-missing-content-digest',
    ]);
  });
});
