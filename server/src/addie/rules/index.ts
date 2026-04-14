import { readFileSync } from 'fs';
import { join, dirname } from 'path';
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
 * Files are read once and cached in memory.
 */
export function loadRules(): string {
  if (cachedPrompt) return cachedPrompt;

  const parts: string[] = [];
  for (const filename of RULE_FILES) {
    const content = readFileSync(join(__dirname, filename), 'utf-8').trim();
    if (content) parts.push(content);
  }

  cachedPrompt = parts.join('\n\n---\n\n');
  return cachedPrompt;
}

export function invalidateRulesCache(): void {
  cachedPrompt = null;
}
