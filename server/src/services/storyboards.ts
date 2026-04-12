/**
 * Storyboard service
 *
 * Thin wrapper around @adcp/client's bundled storyboards.
 * Storyboard YAML definitions live in the @adcp/client package;
 * this module re-exports the functions the server needs and adds
 * test-kit loading (test kits are also bundled with @adcp/client).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  loadBundledStoryboards,
  getStoryboardById,
  listStoryboards as clientListStoryboards,
  extractScenariosFromStoryboard,
} from '@adcp/client/testing';
import type { Storyboard } from '@adcp/client/testing';
import { createLogger } from '../logger.js';

const logger = createLogger('storyboards');

// ── Re-export types from @adcp/client ───────────────────────────

export type {
  Storyboard,
  StoryboardPhase,
  StoryboardStep,
  StoryboardValidation,
} from '@adcp/client/testing';

// ── Test Kit types & loading ────────────────────────────────────

export interface TestKit {
  id: string;
  name: string;
  description: string;
  brand: Record<string, unknown>;
  assets: Record<string, unknown>;
}

export interface StoryboardSummary {
  id: string;
  title: string;
  category: string;
  summary: string;
  interaction_model: string;
  examples: string[];
  phase_count: number;
  step_count: number;
}

const testKits = new Map<string, TestKit>();

function findTestKitsDir(): string | null {
  // Test kits are bundled with @adcp/client at storyboards/test-kits/
  const candidates = [
    resolve(import.meta.dirname, '..', '..', '..', 'node_modules', '@adcp', 'client', 'storyboards', 'test-kits'),
    resolve(process.cwd(), 'node_modules', '@adcp', 'client', 'storyboards', 'test-kits'),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  return null;
}

function loadTestKits(): void {
  try {
    const dir = findTestKitsDir();
    if (!dir) {
      logger.info('Test kits directory not found; test kit features disabled');
      return;
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const kit = YAML.parse(content) as TestKit;
        if (kit.id) {
          testKits.set(kit.id, kit);
          logger.info({ id: kit.id }, 'Loaded test kit');
        }
      } catch (err) {
        logger.error({ err, file }, 'Failed to parse test kit YAML');
      }
    }

    logger.info({ testKits: testKits.size }, 'Test kits loaded');
  } catch (err) {
    logger.error({ err }, 'Failed to load test kits');
  }
}

// Load test kits on import
loadTestKits();

// ── Public API ──────────────────────────────────────────────────

export function listStoryboards(category?: string): StoryboardSummary[] {
  const all = loadBundledStoryboards();
  const filtered = category ? all.filter((sb) => sb.category === category) : all;

  return filtered.map((sb) => ({
    id: sb.id,
    title: sb.title,
    category: sb.category,
    summary: sb.summary,
    interaction_model: sb.agent.interaction_model,
    examples: sb.agent.examples || [],
    phase_count: sb.phases.length,
    step_count: sb.phases.reduce((sum, phase) => sum + phase.steps.length, 0),
  }));
}

export function getStoryboard(id: string): Storyboard | undefined {
  return getStoryboardById(id);
}

export function getAllStoryboards(): Storyboard[] {
  return loadBundledStoryboards();
}

export function getTestKit(id: string): TestKit | undefined {
  return testKits.get(id);
}

export function getTestKitForStoryboard(storyboardId: string): TestKit | undefined {
  const sb = getStoryboardById(storyboardId);
  if (!sb?.prerequisites?.test_kit) return undefined;

  // test_kit is like "test-kits/acme-outdoor.yaml" — extract the id
  const filename = sb.prerequisites.test_kit.replace(/^test-kits\//, '').replace(/\.yaml$/, '');
  // Convert filename to id format (acme-outdoor → acme_outdoor)
  const kitId = filename.replace(/-/g, '_');
  return testKits.get(kitId);
}

export { extractScenariosFromStoryboard };
