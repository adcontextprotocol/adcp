/**
 * Buyer-Skill Wiring (call-adcp-agent)
 *
 * Ensures that:
 * - The cross-cutting `call-adcp-agent` skill is loaded by Addie's skill index
 *   (frontmatter-driven, not directory-name-driven)
 * - Searches for buyer-side terms surface content from the buyer skill
 * - Every search response carries the buyer-rules preamble at the top
 * - call_adcp_task's tool description carries the two non-negotiable rules
 *   (idempotency replay + issues[].variants recovery)
 * - resolveSkillsDir locates skills/ in dev, prod, and CWD layouts
 *
 * Run with: npx vitest run tests/addie/buyer-skill-wiring.test.ts
 */

import { describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ADCP_TOOLS,
  createAdcpToolHandlers,
  resolveSkillsDir,
} from '../../server/src/addie/mcp/adcp-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '../../skills');

describe('call-adcp-agent skill on disk', () => {
  test('SKILL.md exists at the expected path', () => {
    const skillPath = path.join(SKILLS_DIR, 'call-adcp-agent', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
  });

  test('skill body covers idempotency, oneOf, async submitted, and error envelope', () => {
    const skillPath = path.join(SKILLS_DIR, 'call-adcp-agent', 'SKILL.md');
    const body = fs.readFileSync(skillPath, 'utf-8');
    expect(body).toMatch(/idempotency_key/);
    expect(body).toMatch(/oneOf/);
    expect(body).toMatch(/status:\s*'submitted'|status:\s*"submitted"/);
    expect(body).toMatch(/adcp_error/);
    expect(body).toMatch(/issues\[\]/);
  });

  test('frontmatter pins the AdCP version and tags the skill type', () => {
    const skillPath = path.join(SKILLS_DIR, 'call-adcp-agent', 'SKILL.md');
    const body = fs.readFileSync(skillPath, 'utf-8');
    expect(body).toMatch(/^---[\s\S]*?adcp_version:\s*"3\.x"[\s\S]*?---/);
    expect(body).toMatch(/^---[\s\S]*?type:\s*cross-cutting[\s\S]*?---/);
  });
});

describe('resolveSkillsDir', () => {
  test('locates the skills directory from the test runtime', () => {
    const dir = resolveSkillsDir();
    expect(dir).not.toBeNull();
    expect(fs.statSync(dir!).isDirectory()).toBe(true);
    // Basic sanity: contains at least the canonical buyer skill
    expect(fs.existsSync(path.join(dir!, 'call-adcp-agent', 'SKILL.md'))).toBe(true);
  });
});

describe('ask_about_adcp_task surfaces buyer rules', () => {
  const handlers = createAdcpToolHandlers(null);
  const ask = handlers.get('ask_about_adcp_task')!;

  test('the no-keyword fallback shows the buyer preamble + protocol areas', async () => {
    // Stop-word-only query short-circuits to formatAvailableAreas
    const result = await ask({ question: 'the' });
    expect(result).toMatch(/Buyer-side rules/);
    expect(result).toMatch(/idempotency_key/);
    expect(result).toMatch(/Available AdCP protocol areas/);
  });

  test('every search response begins with the buyer-rules preamble', async () => {
    const result = await ask({ question: 'create a media buy' });
    expect(result.indexOf('Buyer-side rules')).toBeGreaterThanOrEqual(0);
    expect(result).toMatch(/idempotency_key/);
    expect(result).toMatch(/account is oneOf/);
    expect(result).toMatch(/issues\[\]\.variants\[\]/);
  });

  test('searching for "idempotency" returns buyer-area content', async () => {
    const result = await ask({ question: 'idempotency' });
    expect(result).toMatch(/idempotency_key/);
    expect(result).toMatch(/\(buyer\)/);
  });

  test('searching for "oneOf" returns the variant rule', async () => {
    const result = await ask({ question: 'oneOf variant account' });
    expect(result).toMatch(/oneOf|variant/i);
    expect(result).toMatch(/\(buyer\)/);
  });

  test('searching for "submitted" returns async polling guidance', async () => {
    const result = await ask({ question: 'status submitted task_id' });
    expect(result).toMatch(/submitted/);
    expect(result).toMatch(/\(buyer\)/);
  });

  test('searching for "validation error" returns recovery guidance', async () => {
    const result = await ask({ question: 'validation error recovery issues' });
    expect(result).toMatch(/issues|recovery|VALIDATION_ERROR/i);
    expect(result).toMatch(/\(buyer\)/);
  });
});

describe('call_adcp_task tool description', () => {
  const callTool = ADCP_TOOLS.find(t => t.name === 'call_adcp_task');

  test('the tool exists', () => {
    expect(callTool).toBeDefined();
  });

  test('description carries the two non-negotiable rules a search round-trip cannot rescue', () => {
    // Per prompt-engineer review: only idempotency replay and issues[].variants[]
    // recovery belong in the tool description (always-on context). The full rule
    // list lives in the search preamble.
    const desc = callTool!.description;
    expect(desc).toMatch(/idempotency_key/);
    expect(desc).toMatch(/double-book/);
    expect(desc).toMatch(/issues\[\]\.variants\[\]/);
    expect(desc).toMatch(/ask_about_adcp_task/);
  });
});
