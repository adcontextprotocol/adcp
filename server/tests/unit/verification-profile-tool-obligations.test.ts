import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  agentOwesTool,
  isClassifiedTask,
} from '../../src/services/verification-profile-tool-obligations.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const schemaRoot = join(repoRoot, 'static', 'schemas', 'source');

/**
 * `## ` sections of docs/protocol/required-tasks.mdx mapped to the
 * `supported_protocols` value that owes their rows. `null` sections (Shared,
 * Accounts) list tasks no protocol claim brings with it.
 */
const REQUIRED_TASKS_SECTION_PROTOCOLS: Readonly<Record<string, string | null>> = {
  Shared: null,
  'Accounts Protocol': null,
  'Media Buy Protocol': 'media_buy',
  'Creative Protocol': 'creative',
  'Signals Protocol': 'signals',
  'Brand Protocol': 'brand',
  'Sponsored Intelligence Protocol': 'sponsored_intelligence',
};

/**
 * Request-schema directories mapped like the table sections: the protocol a
 * claim brings their tasks with, or `null` for tasks no protocol claim brings.
 */
const SCHEMA_DIR_PROTOCOLS: Readonly<Record<string, string | null>> = {
  protocol: null,
  account: null,
  compliance: null,
  core: null,
  'trusted-match': null,
  'media-buy': 'media_buy',
  creative: 'creative',
  signals: 'signals',
  brand: 'brand',
  governance: 'governance',
  property: 'governance',
  collection: 'governance',
  'content-standards': 'governance',
  'sponsored-intelligence': 'sponsored_intelligence',
};

function universalRequiredTools(): Map<string, Set<string>> {
  const roots = [join(repoRoot, 'static', 'compliance', 'source')];
  const dist = join(repoRoot, 'dist', 'compliance');
  if (existsSync(dist)) {
    for (const version of readdirSync(dist)) {
      if (/^\d+\.\d+\.\d+/.test(version)) roots.push(join(dist, version));
    }
  }
  const tools = new Map<string, Set<string>>();
  // Released bundles repeat most files verbatim; parse each distinct text once.
  const seen = new Set<string>();
  for (const root of roots) {
    const dir = join(root, 'universal');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(name => name.endsWith('.yaml'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      if (seen.has(text)) continue;
      seen.add(text);
      const storyboard = YAML.parse(text);
      if (!Array.isArray(storyboard?.phases)) continue;
      for (const tool of storyboard.required_tools ?? []) {
        if (!tools.has(tool)) tools.set(tool, new Set());
        tools.get(tool)!.add(`${root.slice(repoRoot.length + 1)}/${file}`);
      }
    }
  }
  return tools;
}

function protocolForRequiredTasksSection(heading: string): string | null {
  if (heading.startsWith('Governance:')) return 'governance';
  const protocol = REQUIRED_TASKS_SECTION_PROTOCOLS[heading];
  if (protocol === undefined) {
    throw new Error(`required-tasks.mdx section "${heading}" lists tasks but maps to no protocol`);
  }
  return protocol;
}

/** Task -> protocols owing it, per row of the "Required tasks by protocol" table. */
function requiredTasksTableAttribution(): Map<string, Set<string>> {
  const text = readFileSync(join(repoRoot, 'docs', 'protocol', 'required-tasks.mdx'), 'utf8');
  const attribution = new Map<string, Set<string>>();
  let heading = '';
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^## (.+?)\s*$/);
    if (section) heading = section[1];
    const task = line.match(/^\|\s*\[?`([a-z_]+)`/)?.[1];
    if (!task) continue;
    const protocol = protocolForRequiredTasksSection(heading);
    if (!attribution.has(task)) attribution.set(task, new Set());
    if (protocol) attribution.get(task)!.add(protocol);
  }
  return attribution;
}

/** Task -> protocols whose schema directory holds its request schema. */
function requestSchemaAttribution(): Map<string, Set<string>> {
  const attribution = new Map<string, Set<string>>();
  const dirs = readdirSync(schemaRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
  for (const { name: dir } of dirs) {
    const requests = readdirSync(join(schemaRoot, dir)).filter(name => name.endsWith('-request.json'));
    if (requests.length === 0) continue;
    const protocol = SCHEMA_DIR_PROTOCOLS[dir];
    if (protocol === undefined) {
      throw new Error(`schema directory "${dir}" holds request schemas but maps to no protocol`);
    }
    for (const file of requests) {
      const task = file.slice(0, -'-request.json'.length).replace(/-/g, '_');
      if (!attribution.has(task)) attribution.set(task, new Set());
      if (protocol) attribution.get(task)!.add(protocol);
    }
  }
  return attribution;
}

function supportedProtocols(): string[] {
  const schema = JSON.parse(readFileSync(join(schemaRoot, 'protocol', 'get-adcp-capabilities-response.json'), 'utf8'));
  return schema.properties.supported_protocols.items.enum;
}

describe('verification profile tool obligations', () => {
  it('classifies every required tool a universal storyboard names', () => {
    const tools = universalRequiredTools();
    expect(tools.size).toBeGreaterThan(0);
    const unclassified = [...tools].filter(([tool]) => !isClassifiedTask(tool))
      .map(([tool, files]) => `${tool} (${[...files][0]})`);
    expect(unclassified).toEqual([]);
  });

  it('attributes every classified task to the protocols the spec assigns it', () => {
    const table = requiredTasksTableAttribution();
    const schemas = requestSchemaAttribution();
    const protocols = supportedProtocols();
    expect(table.size).toBeGreaterThan(0);
    expect(protocols.length).toBeGreaterThan(0);

    const universal = universalRequiredTools();
    const tasks = new Set([...table.keys(), ...schemas.keys(), ...universal.keys()]);
    const drift: string[] = [];
    for (const tool of tasks) {
      // Always-owed and unclassified tasks never depend on attribution; the
      // classification test above guards the unclassified universal ones.
      if (agentOwesTool(tool, new Set(), {})) continue;
      // The table is authoritative; a request schema directory attributes only
      // tasks the table omits. An empty raw capability block keeps shared
      // capability-conditional tasks unowed, so only protocol claims count.
      const expected = [...(table.get(tool) ?? schemas.get(tool) ?? [])].sort();
      const actual = protocols.filter(protocol => agentOwesTool(tool, new Set([protocol]), {})).sort();
      if (!table.has(tool) && !schemas.has(tool)) {
        drift.push(`${tool} (${[...universal.get(tool) ?? []][0]}): no row in required-tasks.mdx and no request schema`);
      } else if (expected.join() !== actual.join()) {
        drift.push(`${tool}: spec [${expected.join(', ')}], obligations [${actual.join(', ')}]`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('owes a declared protocol its own tasks, including optional ones', () => {
    expect(agentOwesTool('get_products', new Set(['media_buy']), {})).toBe(true);
    expect(agentOwesTool('list_creatives', new Set(['media_buy']), {})).toBe(true);
    expect(agentOwesTool('get_signals', new Set(['signals']), {})).toBe(true);
    expect(agentOwesTool('get_products', new Set(['signals']), {})).toBe(false);
    expect(agentOwesTool('validate_input', new Set(['signals']), undefined)).toBe(false);
  });

  it('owes discovery, the controller and unknown tasks to every agent', () => {
    for (const tool of ['get_adcp_capabilities', 'comply_test_controller', 'a_future_task']) {
      expect(agentOwesTool(tool, new Set(['signals']), {})).toBe(true);
    }
  });

  it('owes shared tasks only when the agent declares the capability that requires them', () => {
    const signals = new Set(['signals']);
    expect(agentOwesTool('sync_accounts', signals, {})).toBe(false);
    expect(agentOwesTool('sync_accounts', signals, { account: { supported_billing: ['operator'] } })).toBe(true);
    expect(agentOwesTool('sync_principal', signals, { adcp: { principal: { supported: false } } })).toBe(false);
    expect(agentOwesTool('get_principal', signals, { adcp: { principal: { supported: true } } })).toBe(true);
    const notifications = (registration_task?: string) => ({
      adcp: { capability_changes: { notifications: { supported: true, registration_task } } },
    });
    expect(agentOwesTool('sync_agent_notification_configs', signals, notifications())).toBe(true);
    expect(agentOwesTool('sync_agent_notification_configs', signals, notifications('sync_principal'))).toBe(false);
    for (const tool of ['sync_accounts', 'sync_principal', 'sync_agent_notification_configs']) {
      expect(agentOwesTool(tool, signals, undefined)).toBe(true);
    }
  });
});
