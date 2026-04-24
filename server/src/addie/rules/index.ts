import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RULE_FILES = [
  'identity.md',
  'behaviors.md',
  'knowledge.md',
  'constraints.md',
  'response-style.md',
];

let cachedPrompt: string | null = null;

/**
 * Load all rule markdown files and return them joined with section separators.
 * Includes:
 * 1. The five rule markdown files (identity, behaviors, knowledge, constraints, response-style)
 * 2. `.agents/current-context.md` — active AdCP roadmap snapshot (refreshed weekly by the context-refresh routine)
 * 3. An expert-panel summary built from `.claude/agents/*.md` frontmatter — tells Addie which personas exist and when to invoke their voice
 *
 * Files are read once and cached in memory. Call `invalidateRulesCache()`
 * when underlying files change (e.g., after a deploy that bumps the context snapshot).
 */
export function loadRules(): string {
  if (cachedPrompt) return cachedPrompt;

  const parts: string[] = [];
  for (const filename of RULE_FILES) {
    const content = readFileSync(join(__dirname, filename), 'utf-8').trim();
    if (content) parts.push(content);
  }

  const currentContext = loadCurrentContext();
  if (currentContext) {
    parts.push(`# Current AdCP Context\n\n${currentContext}`);
  }

  const expertPanel = loadExpertPanelSummary();
  if (expertPanel) {
    parts.push(`# Expert Panel\n\n${expertPanel}`);
  }

  cachedPrompt = parts.join('\n\n---\n\n');
  return cachedPrompt;
}

export function invalidateRulesCache(): void {
  cachedPrompt = null;
}

/**
 * Walk up from a starting directory looking for `.agents/` — returns the
 * repo root path or null. Works in both dev (cwd-based) and prod (bundled)
 * layouts without relying on a fixed `../../..` depth.
 */
function findRepoRoot(): string | null {
  const candidates = [process.cwd(), __dirname];
  for (const start of candidates) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, '.agents'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Read `.agents/current-context.md` from the repo root if available.
 * Returns null (no injection) when the file is missing — e.g., in a deploy
 * that doesn't include the agent infrastructure.
 */
function loadCurrentContext(): string | null {
  const root = findRepoRoot();
  if (!root) return null;
  const path = join(root, '.agents', 'current-context.md');
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Build a compact expert-panel reference from `.claude/agents/*.md`
 * frontmatter. Extracts `name` + `description` from each agent file; the
 * full persona body is not inlined (Addie doesn't need to be the experts,
 * just to know they exist and when their voice is appropriate).
 *
 * When Brian adds or refines an expert persona, the next Addie restart
 * picks it up automatically.
 */
function loadExpertPanelSummary(): string | null {
  const root = findRepoRoot();
  if (!root) return null;
  const agentsDir = join(root, '.claude', 'agents');
  if (!existsSync(agentsDir)) return null;

  let files: string[];
  try {
    files = readdirSync(agentsDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const lines: string[] = [
    'The AdCP ecosystem has a shared panel of expert personas. When a user asks a deep question in one of these areas, respond in the voice of the relevant expert — cite concrete files, prior art, and operator reality over protocol-aesthetic. For explicit multi-expert consultation or high-stakes protocol analysis, flag that the question deserves a full expert pass rather than improvising.',
    '',
  ];

  for (const filename of files) {
    const parsed = parseAgentFrontmatter(join(agentsDir, filename));
    if (!parsed) continue;
    lines.push(`- **${parsed.name}** — ${parsed.description}`);
  }

  if (lines.length <= 2) return null;
  return lines.join('\n');
}

interface AgentFrontmatter {
  name: string;
  description: string;
}

function parseAgentFrontmatter(path: string): AgentFrontmatter | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1];
  const name = extractFrontmatterField(block, 'name');
  const description = extractFrontmatterField(block, 'description');
  if (!name || !description) return null;
  return { name, description };
}

function extractFrontmatterField(block: string, field: string): string | null {
  const re = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm');
  const match = block.match(re);
  return match ? match[1].trim() : null;
}
