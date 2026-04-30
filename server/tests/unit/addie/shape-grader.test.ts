/**
 * Unit tests for the shared response shape grader.
 *
 * The fixture set anchors on real cases the grader needs to flag — most
 * importantly the registry/Katie thread (21-word multi-part question, ~280
 * words of bold-headed bullet-laden response, closing follow-up question).
 * The existing length post-processor's 15-word trigger misses this case;
 * this test fails-loud if a future change re-narrows the trigger and lets
 * the same shape slip through again.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyQuestion,
  analyzeResponseShape,
  gradeShape,
} from '../../../src/addie/testing/shape-grader.js';

const KATIE_QUESTION =
  'How does an agent get registered on the AAO registry? Do you have to pay and do you have to be an AAO member?';

const KATIE_ADDIE_RESPONSE = `Here's how agent registration on the AAO registry works:

**Two paths to get an agent into the registry:**

1. **Self-hosted via adagents.json (free, no membership required)**
Publishers can declare their authorized agents by hosting a /.well-known/adagents.json file on their domain. The registry crawls these automatically — when the crawler discovers an agent URL there, it's indexed as an agent.discovered event. No payment, no membership needed. This is the authoritative path.

2. **Registered via the dashboard (membership required for full visibility)**
Members can register an agent through Addie or the dashboard using the save_agent flow. New agents land with members_only visibility — discoverable to Professional-tier (or higher) members but not publicly listed. To promote an agent to full public listing in the directory and brand.json, you go through the dashboard publish flow, which requires an API-access tier (Builder at $2,500/year or higher).

**Summary on membership/payment:**
- Reading the registry (resolving brands, discovering agents, validating authorization) is **free and public** — no auth required for most endpoints.
- Getting an agent discovered via adagents.json is also **free** — just host the file.
- Public directory listing of your agent requires at minimum a **Builder membership ($2,500/year)**, which includes API access.
- The members-only visibility tier sits at **Professional ($250/year)**.

The full registry API reference is at docs.adcontextprotocol.org/docs/registry — worth a read if you're deciding which path fits your situation. What kind of agent are you looking to register?`;

const BRIAN_TLDR = `TLDR: it's free and you don't have to be a member BUT only members can see your agent until you are a member.

Free registration: members can see your agent
Paid registration: anybody can see your agent`;

describe('classifyQuestion', () => {
  it('flags a short yes/no challenge with the tightest cap', () => {
    const q = classifyQuestion('Is AdCP just surveillance capitalism at AI speed?');
    expect(q.wordCount).toBeLessThanOrEqual(15);
    expect(q.isMultiPart).toBe(false);
    expect(q.expectedMaxWords).toBe(120);
  });

  it('detects multi-part via two question marks', () => {
    const q = classifyQuestion(KATIE_QUESTION);
    expect(q.isMultiPart).toBe(true);
    // Multi-part is a shape signal, not a budget multiplier. Cap follows
    // the base scale: 16-30 words → 200.
    expect(q.expectedMaxWords).toBe(200);
  });

  it('detects multi-part via "and" / "also" / "plus" conjunctions', () => {
    const q = classifyQuestion('How does the registry work and what does it cost.');
    expect(q.isMultiPart).toBe(true);
  });

  it('does not call a single short question multi-part', () => {
    const q = classifyQuestion('How does the registry work?');
    expect(q.isMultiPart).toBe(false);
  });

  it('does NOT treat "and" inside a noun phrase as multi-part', () => {
    // The conjunction joins two nouns inside a single question. The
    // tightened regex requires "and"/"also"/"plus" to be followed by an
    // interrogative or auxiliary so this kind of phrase isn't mis-flagged.
    expect(classifyQuestion("What's the difference between buyer and seller agents?").isMultiPart).toBe(false);
    expect(classifyQuestion('How do publisher and platform agents differ?').isMultiPart).toBe(false);
    expect(classifyQuestion('Tell me about TMP and OpenRTB.').isMultiPart).toBe(false);
  });

  it('treats "and <interrogative>" as multi-part', () => {
    expect(classifyQuestion('How does the registry work and what does it cost?').isMultiPart).toBe(true);
    expect(classifyQuestion('Where is the spec and how do I read it?').isMultiPart).toBe(true);
  });

  it('scales the cap with question length above 30 words, capped at 400', () => {
    const longQuestion =
      'I want to walk through the full process of registering my seller agent for compliance monitoring including how to declare specialisms what storyboards run by default and what happens during the certification stage of the process please explain end to end?';
    const q = classifyQuestion(longQuestion);
    expect(q.wordCount).toBeGreaterThan(30);
    expect(q.expectedMaxWords).toBeGreaterThan(200);
    expect(q.expectedMaxWords).toBeLessThanOrEqual(400);
  });
});

describe('analyzeResponseShape', () => {
  it('counts standalone bold heading lines but not inline bold', () => {
    const text = `**Heading One**

Some prose with **inline bold** that is not a heading.

**Heading Two:**
- bullet`;
    const r = analyzeResponseShape(text);
    expect(r.boldHeadingCount).toBe(2);
  });

  it('counts bullets and numbered list items separately', () => {
    const text = `Some intro.

- bullet a
- bullet b
* bullet c
• bullet d

1. item one
2. item two`;
    const r = analyzeResponseShape(text);
    expect(r.bulletCount).toBe(4);
    expect(r.numberedListCount).toBe(2);
  });

  it('detects a closing question mark', () => {
    expect(analyzeResponseShape('Yes that works.').endsWithQuestion).toBe(false);
    expect(analyzeResponseShape('What kind of agent?').endsWithQuestion).toBe(true);
  });

  it('detects the default-template signature on the registry response', () => {
    const r = analyzeResponseShape(KATIE_ADDIE_RESPONSE);
    expect(r.boldHeadingCount).toBeGreaterThanOrEqual(2);
    expect(r.bulletCount + r.numberedListCount).toBeGreaterThanOrEqual(4);
    expect(r.endsWithQuestion).toBe(true);
    expect(r.usesDefaultTemplate).toBe(true);
    expect(r.structuredHeavy).toBe(true);
  });

  it('flags structuredHeavy on essay-shape that ends in a period (no closing question)', () => {
    // The default-template detector requires a closing question; if a
    // response has the same heading + list mass but ends in a period
    // ("Let me know if that helps."), structuredHeavy still fires while
    // usesDefaultTemplate does not.
    const text = `Here's how registration works.

**Self-hosted via adagents.json:**
- free, no membership required
- crawler indexes automatically
- authoritative path

**Dashboard registration:**
- members-only visibility by default
- Builder tier needed for public listing

Let me know if that helps.`;
    const r = analyzeResponseShape(text);
    expect(r.structuredHeavy).toBe(true);
    expect(r.usesDefaultTemplate).toBe(false);
  });

  it('does not flag the human TLDR as default-template or structuredHeavy', () => {
    const r = analyzeResponseShape(BRIAN_TLDR);
    expect(r.usesDefaultTemplate).toBe(false);
    expect(r.structuredHeavy).toBe(false);
  });

  it('flags a sign-in opener', () => {
    const text =
      "I don't have documentation search tools available in this context, but here's what I know.";
    const r = analyzeResponseShape(text);
    expect(r.signInOpenerHit).toBe(true);
  });

  it('does not flag a sign-in mention deep in the response', () => {
    const lateMention =
      'AdCP is a protocol for agentic advertising. It standardizes media buying, creative, and signals flows. ' +
      'Members get access to working groups and certification. ' +
      'If you want member-specific features you can sign in at agenticadvertising.org. ' +
      'But you do not have to sign in to use the docs.';
    const r = analyzeResponseShape(lateMention);
    expect(r.signInOpenerHit).toBe(false);
  });

  it('catches a banned ritual phrase', () => {
    const text = "Great question — AdCP doesn't introduce new identifiers.";
    const r = analyzeResponseShape(text);
    expect(r.bannedRitualHits.length).toBeGreaterThan(0);
  });

  it('excludes fenced code-block content from word count', () => {
    // A short question like "draw a mermaid diagram of X" legitimately
    // produces a long fenced block. Counting code as words tripped
    // length_cap when no actual prose was verbose.
    const codeHeavy = `Here's the diagram:

\`\`\`mermaid
sequenceDiagram
    participant A as Alpha
    participant B as Beta
    A ->> B: request
    B -->> A: response
    A ->> B: another
    B -->> A: more
\`\`\`

Let me know if you want it adjusted.`;
    const r = analyzeResponseShape(codeHeavy);
    // Prose is "Here's the diagram:" + "Let me know if you want it adjusted."
    // = ~10 words. Without the fix the count would be ~30+ words including
    // the mermaid syntax.
    expect(r.wordCount).toBeLessThan(15);
  });

  it('keeps inline backtick code in word count (not fenced)', () => {
    const inline = 'Use the `search_docs` tool with query "addie tools".';
    const r = analyzeResponseShape(inline);
    expect(r.wordCount).toBeGreaterThan(5);
  });

  it('strips multiple fenced blocks', () => {
    const multi = `First:
\`\`\`
console.log('a')
\`\`\`
Then:
\`\`\`json
{"x": 1}
\`\`\`
Done.`;
    const r = analyzeResponseShape(multi);
    expect(r.wordCount).toBeLessThan(8);
  });
});

describe('gradeShape — Katie/registry case is the load-bearing fixture', () => {
  it('flags the registry response as length-cap exceeded', () => {
    const report = gradeShape(KATIE_QUESTION, KATIE_ADDIE_RESPONSE);
    expect(report.violations.exceededLengthCap).toBe(true);
    expect(report.violations.ratioToExpected).toBeGreaterThan(1);
  });

  it('flags the registry response as default-template', () => {
    const report = gradeShape(KATIE_QUESTION, KATIE_ADDIE_RESPONSE);
    expect(report.violations.defaultTemplateUsed).toBe(true);
    expect(report.violationLabels).toContain('default_template');
  });

  it('does NOT flag comprehensive_dump on the registry response', () => {
    // The registry question IS multi-part, so list-shape is justified.
    // comprehensive_dump fires only when the question is single-part.
    const report = gradeShape(KATIE_QUESTION, KATIE_ADDIE_RESPONSE);
    expect(report.violations.comprehensiveDumpDetected).toBe(false);
  });

  it('flags a single-part question with a many-bullet dump as comprehensive_dump', () => {
    const question = 'What does AdCP not do?';
    const dumpResponse = `**Security**
- no end-user auth
- no cryptographic verification
- no chain of custody
- no escrow
- no key rotation

**Operational**
- no SLAs
- no measurement reconciliation
- no dispute resolution

What would you like to dig into?`;
    const report = gradeShape(question, dumpResponse);
    expect(report.violations.comprehensiveDumpDetected).toBe(true);
    expect(report.violationLabels).toContain('comprehensive_dump');
  });

  it('passes the human TLDR as a clean response', () => {
    const report = gradeShape(KATIE_QUESTION, BRIAN_TLDR);
    expect(report.violations.exceededLengthCap).toBe(false);
    expect(report.violations.defaultTemplateUsed).toBe(false);
    expect(report.violations.comprehensiveDumpDetected).toBe(false);
    expect(report.violationLabels).toEqual([]);
  });

  it('passes a one-paragraph good answer to a sharp question', () => {
    const question = 'Is AdCP just surveillance capitalism at AI speed?';
    const goodAnswer =
      'No — AdCP does not create new identifiers, merge consent pools, or introduce new tracking. It standardizes the shapes of flows that already exist today in bespoke bilateral integrations. A standardized protocol is structurally easier to audit and constrain than the ad-hoc integrations it replaces.';
    const report = gradeShape(question, goodAnswer);
    expect(report.violations.exceededLengthCap).toBe(false);
    expect(report.violations.defaultTemplateUsed).toBe(false);
    expect(report.violationLabels).toEqual([]);
  });
});
