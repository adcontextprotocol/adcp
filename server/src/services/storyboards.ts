/**
 * Storyboard service
 *
 * Loads and serves storyboard definitions from docs/storyboards/*.yaml.
 * Storyboards are narrative test workflows that walk agent builders through
 * the sequence of calls their agent receives, organized by interaction model.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { createLogger } from '../logger.js';

const logger = createLogger('storyboards');

// ── Types ────────────────────────────────────────────────────────

export interface StoryboardValidation {
  check: 'response_schema' | 'field_present' | 'field_value' | 'status_code' | 'error_code';
  path?: string;
  /** Expected value for field_value and error_code checks */
  value?: unknown;
  /** Accepted values for field_value checks (passes if actual matches any) */
  allowed_values?: unknown[];
  description: string;
}

export interface StoryboardStep {
  id: string;
  title: string;
  narrative: string;
  task: string;
  schema_ref: string;
  response_schema_ref?: string;
  doc_ref: string;
  comply_scenario?: string;
  stateful: boolean;
  expected: string;
  sample_request?: Record<string, unknown>;
  sample_response?: Record<string, unknown>;
  validations?: StoryboardValidation[];
}

export interface StoryboardPhase {
  id: string;
  title: string;
  narrative: string;
  steps: StoryboardStep[];
}

export interface StoryboardAgent {
  interaction_model: string;
  capabilities: string[];
  examples: string[];
}

export interface StoryboardCaller {
  role: string;
  example: string;
}

export interface StoryboardPrerequisites {
  description: string;
  test_kit?: string;
}

export interface Storyboard {
  id: string;
  version: string;
  title: string;
  category: string;
  summary: string;
  track?: string;
  required_tools?: string[];
  platform_types?: string[];
  narrative: string;
  agent: StoryboardAgent;
  caller: StoryboardCaller;
  prerequisites?: StoryboardPrerequisites;
  phases: StoryboardPhase[];
}

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

// ── Service ──────────────────────────────────────────────────────

const storyboards = new Map<string, Storyboard>();
const testKits = new Map<string, TestKit>();

function findStoryboardsDir(): string | null {
  // Walk up from server/src/services to find docs/storyboards
  const candidates = [
    resolve(import.meta.dirname, '..', '..', '..', 'docs', 'storyboards'),
    resolve(import.meta.dirname, '..', '..', '..', '..', 'docs', 'storyboards'),
    resolve(process.cwd(), 'docs', 'storyboards'),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  return null;
}

function loadStoryboards(): void {
  try {
    const dir = findStoryboardsDir();
    if (!dir) {
      logger.info('Storyboards directory not found; storyboard features disabled');
      return;
    }
    const files = readdirSync(dir).filter(
      (f) => f.endsWith('.yaml') && f !== 'schema.yaml',
    );

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const storyboard = YAML.parse(content) as Storyboard;

        if (!storyboard.id || !storyboard.phases) {
          logger.warn({ file }, 'Skipping invalid storyboard (missing id or phases)');
          continue;
        }

        storyboards.set(storyboard.id, storyboard);
        logger.info({ id: storyboard.id, phases: storyboard.phases.length }, 'Loaded storyboard');
      } catch (err) {
        logger.error({ err, file }, 'Failed to parse storyboard YAML');
      }
    }

    // Load test kits
    const testKitDir = join(dir, 'test-kits');
    if (existsSync(testKitDir)) {
      const kitFiles = readdirSync(testKitDir).filter((f) => f.endsWith('.yaml'));
      for (const file of kitFiles) {
        try {
          const content = readFileSync(join(testKitDir, file), 'utf-8');
          const kit = YAML.parse(content) as TestKit;
          if (kit.id) {
            testKits.set(kit.id, kit);
            logger.info({ id: kit.id }, 'Loaded test kit');
          }
        } catch (err) {
          logger.error({ err, file }, 'Failed to parse test kit YAML');
        }
      }
    }

    logger.info(
      { storyboards: storyboards.size, testKits: testKits.size },
      'Storyboard service initialized',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to initialize storyboard service');
  }
}

// Load on import
loadStoryboards();

// ── Public API ───────────────────────────────────────────────────

export function listStoryboards(category?: string): StoryboardSummary[] {
  const results: StoryboardSummary[] = [];

  for (const sb of storyboards.values()) {
    if (category && sb.category !== category) continue;

    const stepCount = sb.phases.reduce((sum, phase) => sum + phase.steps.length, 0);

    results.push({
      id: sb.id,
      title: sb.title,
      category: sb.category,
      summary: sb.summary,
      interaction_model: sb.agent.interaction_model,
      examples: sb.agent.examples,
      phase_count: sb.phases.length,
      step_count: stepCount,
    });
  }

  return results;
}

export function getStoryboard(id: string): Storyboard | undefined {
  return storyboards.get(id);
}

export function getAllStoryboards(): Storyboard[] {
  return [...storyboards.values()];
}

export function getTestKit(id: string): TestKit | undefined {
  return testKits.get(id);
}

export function getTestKitForStoryboard(storyboardId: string): TestKit | undefined {
  const sb = storyboards.get(storyboardId);
  if (!sb?.prerequisites?.test_kit) return undefined;

  // test_kit is like "test-kits/acme-outdoor.yaml" — extract the id
  const filename = sb.prerequisites.test_kit.replace(/^test-kits\//, '').replace(/\.yaml$/, '');
  // Convert filename to id format (acme-outdoor → acme_outdoor)
  const kitId = filename.replace(/-/g, '_');
  return testKits.get(kitId);
}

/**
 * Extract unique comply_scenario values from a storyboard.
 * Used to limit comply() to only the scenarios a storyboard references.
 */
export function extractScenariosFromStoryboard(storyboard: Storyboard): string[] {
  const scenarios = new Set<string>();
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.comply_scenario) {
        scenarios.add(step.comply_scenario);
      }
    }
  }
  return [...scenarios];
}

/**
 * Reload storyboards from disk. Useful for development.
 */
export function reloadStoryboards(): void {
  storyboards.clear();
  testKits.clear();
  loadStoryboards();
}
