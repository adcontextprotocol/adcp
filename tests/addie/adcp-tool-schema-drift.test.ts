/**
 * AdCP Task Registry Completeness
 *
 * Ensures that:
 * - Every task in ADCP_TASK_REGISTRY has documentation in a SKILL.md file
 * - The registry contains all expected tasks (snapshot test)
 * - The tool-set references only valid registry tasks or known management tools
 *
 * Run with: npx vitest run tests/addie/adcp-tool-schema-drift.test.ts
 */

import { describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ADCP_TASK_REGISTRY, ADCP_TOOLS } from '../../server/src/addie/mcp/adcp-tools.js';
import { TOOL_SETS } from '../../server/src/addie/tool-sets.js';

const SKILLS_DIR = path.join(__dirname, '../../skills');

/** Agent management tools live in member-tools.ts, not in the task registry */
const AGENT_MANAGEMENT_TOOLS = new Set([
  'save_agent',
  'list_saved_agents',
  'remove_saved_agent',
  'setup_test_agent',
]);

function loadSkillTaskNames(): Set<string> {
  const taskNames = new Set<string>();

  const dirs = fs.readdirSync(SKILLS_DIR).filter(d =>
    d.startsWith('adcp-') && fs.statSync(path.join(SKILLS_DIR, d)).isDirectory()
  );

  for (const dir of dirs) {
    const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillPath, 'utf-8');
    } catch {
      continue;
    }

    // Extract task names from ### headings and backtick references
    const headingMatches = content.matchAll(/^###\s+(\w+)/gm);
    for (const match of headingMatches) {
      taskNames.add(match[1]);
    }

    // Also match `task_name` references in body text
    const backtickMatches = content.matchAll(/`(\w+)`/g);
    for (const match of backtickMatches) {
      if (match[1] in ADCP_TASK_REGISTRY) {
        taskNames.add(match[1]);
      }
    }
  }

  return taskNames;
}

describe('AdCP task registry completeness', () => {
  test('every task in the registry has SKILL.md documentation', () => {
    const documentedTasks = loadSkillTaskNames();
    const registryTasks = Object.keys(ADCP_TASK_REGISTRY);

    const undocumented = registryTasks.filter(t => !documentedTasks.has(t));

    expect(undocumented).toEqual([]);
  });

  test('ADCP_TOOLS exports exactly 3 meta-tools', () => {
    expect(ADCP_TOOLS.map(t => t.name).sort()).toEqual([
      'ask_about_adcp_task',
      'call_adcp_task',
      'get_adcp_capabilities',
    ]);
  });

  test('adcp_operations tool set references only valid tools', () => {
    const adcpOps = TOOL_SETS.adcp_operations;
    expect(adcpOps).toBeDefined();

    for (const toolName of adcpOps.tools) {
      const isRegistryTask = toolName in ADCP_TASK_REGISTRY;
      const isMetaTool = ADCP_TOOLS.some(t => t.name === toolName);
      const isAgentManagement = AGENT_MANAGEMENT_TOOLS.has(toolName);

      expect(
        isRegistryTask || isMetaTool || isAgentManagement,
      ).toBe(true);
    }
  });

  test('registry task names match expected set', () => {
    expect(Object.keys(ADCP_TASK_REGISTRY).sort()).toMatchSnapshot();
  });
});
