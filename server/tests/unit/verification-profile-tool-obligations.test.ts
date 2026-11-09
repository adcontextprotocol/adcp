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

describe('verification profile tool obligations', () => {
  it('classifies every required tool a universal storyboard names', () => {
    const tools = universalRequiredTools();
    expect(tools.size).toBeGreaterThan(0);
    const unclassified = [...tools].filter(([tool]) => !isClassifiedTask(tool))
      .map(([tool, files]) => `${tool} (${[...files][0]})`);
    expect(unclassified).toEqual([]);
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
