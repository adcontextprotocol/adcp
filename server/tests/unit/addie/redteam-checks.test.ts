/**
 * Unit tests for the red-team deterministic checks.
 *
 * These do NOT hit a live Addie endpoint. They test that checkResponse()
 * correctly catches the failure modes we've seen in live eval — fabricated
 * member companies, banned ritual phrases, sign-in deflection, length
 * blow-out, missing concept markers.
 *
 * The live regression itself lives in redteam-runner.ts / redteam-cli.ts
 * and is run via `npm run test:redteam` against a Docker or staging stack.
 */

import { describe, it, expect } from 'vitest';
import { checkResponse } from '../../../src/addie/testing/redteam-runner.js';
import { RED_TEAM_SCENARIOS } from '../../../src/addie/testing/redteam-scenarios.js';

const byId = (id: string) => {
  const s = RED_TEAM_SCENARIOS.find((s) => s.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

describe('redteam checkResponse — deterministic failure detection', () => {
  it('flags fabricated member-company mentions', () => {
    const scenario = byId('gov-1');
    const response =
      "Members include Scope3 competitors — The Trade Desk, Mediaocean, Magnite — and publishers with opposing commercial interests. Apache 2.0 licensing means any member can fork.";
    const failures = checkResponse(scenario, response);
    const fabrications = failures.filter((f) => f.kind === 'fabricated_company');
    expect(fabrications.length).toBeGreaterThan(0);
    expect(fabrications[0].detail).toContain('the trade desk');
  });

  it('allows generic company references without member context', () => {
    const scenario = byId('rtb-2');
    const response =
      "The Trade Desk supports UID2 for identity resolution. AdCP operates at a different layer — it handles cross-seller campaign negotiation, reducing the N×M integration matrix.";
    const failures = checkResponse(scenario, response);
    const fabrications = failures.filter((f) => f.kind === 'fabricated_company');
    expect(fabrications.length).toBe(0);
  });

  it('flags banned ritual phrases anywhere in response', () => {
    const scenario = byId('acct-1');
    const response =
      "That's a great question. The principal — the brand or agency whose account authorized the agent — is legally responsible for spend.";
    const failures = checkResponse(scenario, response);
    const banned = failures.filter((f) => f.kind === 'banned_phrase');
    expect(banned.length).toBeGreaterThan(0);
  });

  it('flags "the honest answer" mid-sentence', () => {
    const scenario = byId('gov-1');
    const response =
      "There are multiple angles. But the honest answer is that Scope3 was a founding contributor, and the governance design assumes the overlap. Apache 2.0 licensing means any member can fork.";
    const failures = checkResponse(scenario, response);
    const banned = failures.filter((f) => f.kind === 'banned_phrase');
    expect(banned.some((f) => f.detail === 'the honest answer is')).toBe(true);
  });

  it('flags sign-in deflection on substantive questions', () => {
    const scenario = byId('cad-2');
    const response =
      "For the full policy details, I'd recommend signing in at agenticadvertising.org for the versioning documentation.";
    const failures = checkResponse(scenario, response);
    const deflects = failures.filter((f) => f.kind === 'signin_deflect');
    expect(deflects.length).toBeGreaterThan(0);
  });

  it('flags "I don\'t have documentation search tools" preamble', () => {
    const scenario = byId('reg-1');
    const response =
      "I don't have documentation search tools available in this context, but GDPR Article 22...";
    const failures = checkResponse(scenario, response);
    const deflects = failures.filter((f) => f.kind === 'signin_deflect');
    expect(deflects.length).toBeGreaterThan(0);
  });

  it('flags length blow-out on short sharp questions', () => {
    const scenario = byId('priv-1'); // shortQuestion: true, cap 160 words
    const longResponse = 'word '.repeat(200).trim(); // 200 words
    const failures = checkResponse(scenario, longResponse + ' none already flow standardize bespoke');
    const lengthFails = failures.filter((f) => f.kind === 'length_cap');
    expect(lengthFails.length).toBe(1);
    expect(lengthFails[0].detail).toContain('160');
  });

  it('passes a short question with a short answer and right markers', () => {
    const scenario = byId('priv-1');
    const response =
      "No — AdCP does not create new identifiers, merge consent pools, or introduce new tracking. It standardizes the shapes of flows that already flow today in bespoke bilateral integrations. A standardized protocol is structurally easier to audit and constrain than ad-hoc integrations.";
    const failures = checkResponse(scenario, response);
    expect(failures).toEqual([]);
  });

  it('flags missing required concept markers', () => {
    const scenario = byId('reg-1'); // requires controller/processor/principal
    const response =
      "AdCP is a protocol. It has things. Ask a lawyer for specifics.";
    const failures = checkResponse(scenario, response);
    const missing = failures.filter((f) => f.kind === 'missing_marker');
    expect(missing.length).toBe(1);
    expect(missing[0].detail).toContain('controller');
  });

  it('flags banned markers (overclaim patterns)', () => {
    const scenario = byId('acct-3'); // bans "adcp makes collusion harder"
    const response =
      "AdCP makes collusion harder through audit trails and logging, so parties can see what happened.";
    const failures = checkResponse(scenario, response);
    const banned = failures.filter((f) => f.kind === 'banned_marker');
    expect(banned.length).toBeGreaterThan(0);
    expect(banned[0].detail.toLowerCase()).toContain('adcp makes collusion harder');
  });

  it('flags banned markers for surveillance overclaim', () => {
    const scenario = byId('priv-1'); // bans "fundamentally different"
    const response =
      "AdCP is fundamentally different from surveillance capitalism because it standardizes existing flows with no new identifiers.";
    const failures = checkResponse(scenario, response);
    const banned = failures.filter((f) => f.kind === 'banned_marker');
    expect(banned.some((f) => f.detail.toLowerCase().includes('fundamentally different'))).toBe(true);
  });

  it('passes a complete concept-driven answer', () => {
    const scenario = byId('acct-3');
    const response =
      "AdCP doesn't prevent collusion through protocol mechanics. What it does is make collusion visible: every negotiation is logged, and the audit trail is available to principals and regulators for enforcement.";
    const failures = checkResponse(scenario, response);
    expect(failures).toEqual([]);
  });

  it('flags the default-template shape regardless of substance', () => {
    // The acct-1 scenario asks "Who is liable when the agent overspends?"
    // A template-shaped answer hits the new shape check even if it
    // contains the required concept markers.
    const scenario = byId('acct-1');
    const response = `Here's how liability works in AdCP:

**Two paths to liability:**

1. **The principal — the brand or agency** that authorized the agent is the legally responsible party for spend. Their account is on the hook.

2. **The operator** runs the agent infrastructure but isn't liable for the buyer's spend. Operators can be held to SLA / fraud standards.

**Summary:**
- Principal = brand/agency = legally responsible
- Operator = infra provider = ops liability
- Agent = software = no legal personhood

What scenario are you working through?`;
    const failures = checkResponse(scenario, response);
    expect(failures.some((f) => f.kind === 'shape_default_template')).toBe(true);
  });

  it('flags a comprehensive bullet dump on a single-part question', () => {
    const scenario = byId('gap-1'); // "What does AdCP not do?"
    const response = `AdCP today doesn't cover:
- end-user authentication
- cryptographic agent verification
- dispute resolution between buyer/seller
- FX handling
- chain-of-custody for measurement
- escrow
- key rotation
- bidder-side budget caps`;
    const failures = checkResponse(scenario, response);
    // gaps-1 is multi-part-ish but if scenario.question doesn't contain
    // 'and' / 'also' / 'plus' or two ?s, dump is detected.
    // Either flag fires depending on the actual question text — assert
    // at least one shape failure surfaces.
    const shapeFailures = failures.filter((f) => f.kind.startsWith('shape_'));
    expect(shapeFailures.length).toBeGreaterThan(0);
  });

  it('flags a sign-in opener regardless of scenario', () => {
    const scenario = byId('gov-2'); // governance question
    const response =
      "I don't have access to the live governance docs in this conversation, but the AAO governance page is at agenticadvertising.org/governance. The board is independent and uses Apache 2.0 licensing for the protocol.";
    const failures = checkResponse(scenario, response);
    expect(failures.some((f) => f.kind === 'shape_signin_opener')).toBe(true);
  });

  it('passes a clean prose answer with no shape violations', () => {
    const scenario = byId('priv-1');
    const response =
      "No — AdCP doesn't create new identifiers, merge consent pools, or introduce new tracking. It standardizes flows that already flow today in bespoke bilateral integrations.";
    const failures = checkResponse(scenario, response);
    expect(failures).toEqual([]);
  });
});

describe('redteam scenarios — structural integrity', () => {
  it('covers all red-team categories', () => {
    // Floor on count rather than exact match — the suite grows over time
    // (e.g. aao-self-knowledge added in the docs/aao/ rollout). Categories
    // listed here are the ones that must always be present.
    expect(RED_TEAM_SCENARIOS.length).toBeGreaterThanOrEqual(25);
    const categories = new Set(RED_TEAM_SCENARIOS.map((s) => s.category));
    expect(categories.has('governance')).toBe(true);
    expect(categories.has('aamp')).toBe(true);
    expect(categories.has('openrtb')).toBe(true);
    expect(categories.has('privacy')).toBe(true);
    expect(categories.has('accountability')).toBe(true);
    expect(categories.has('hitl')).toBe(true);
    expect(categories.has('publisher')).toBe(true);
    expect(categories.has('cadence')).toBe(true);
    expect(categories.has('regulatory')).toBe(true);
    expect(categories.has('gaps')).toBe(true);
  });

  it('every scenario has at least one required concept marker', () => {
    for (const s of RED_TEAM_SCENARIOS) {
      expect(s.requiredMarkers.length, `${s.id} has no required markers`).toBeGreaterThan(0);
    }
  });

  it('every scenario names the concept section it draws from', () => {
    for (const s of RED_TEAM_SCENARIOS) {
      expect(s.concept.length, `${s.id} has empty concept field`).toBeGreaterThan(0);
    }
  });

  it('scenario ids are unique', () => {
    const ids = RED_TEAM_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
