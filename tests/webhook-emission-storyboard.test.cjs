#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { runStoryboard } = require('@adcp/sdk/testing');

const storyboardPath = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'universal',
  'webhook-emission.yaml'
);

function loadStoryboard() {
  return YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
}

test('synchronous completion branch family requires wholesale product discovery', () => {
  const storyboard = loadStoryboard();
  const phaseIds = [
    'synchronous_completion_success_path',
    'synchronous_completion_rejection_path',
    'synchronous_completion_assertion',
  ];

  for (const phaseId of phaseIds) {
    assert.deepEqual(
      storyboard.phases.find(phase => phase.id === phaseId).requires_capability,
      { path: 'media_buy.buying_modes', contains: 'wholesale' },
      phaseId
    );
  }
});

test('synchronous completion assertion is not applicable to a signals-only agent', async () => {
  const source = loadStoryboard();
  const phaseIds = new Set([
    'synchronous_completion_success_path',
    'synchronous_completion_rejection_path',
    'synchronous_completion_assertion',
  ]);
  const storyboard = {
    ...source,
    requires: undefined,
    prerequisites: undefined,
    phases: [
      ...source.phases
        .filter(phase => phaseIds.has(phase.id))
        .map(phase => ({
          ...phase,
          steps: phase.steps.map(step => ({ ...step, sample_request: undefined })),
        })),
      {
        id: 'control',
        title: 'Control',
        optional: true,
        skip_if: 'true',
        steps: [{ id: 'unused', title: 'Unused', task: 'get_signals' }],
      },
    ],
  };

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools: ['get_adcp_capabilities', 'get_signals'],
      raw_capabilities: { supported_protocols: ['signals'] },
    },
    agentTools: ['get_adcp_capabilities', 'get_signals'],
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 4);
  for (const phase of result.phases.filter(phase => phase.phase_id !== 'control')) {
    assert.equal(phase.steps[0].skip.reason, 'not_applicable', phase.phase_id);
  }
  const assertion = result.phases.find(phase => phase.phase_id === 'synchronous_completion_assertion');
  assert.equal(assertion.steps[0].skip_reason, 'not_applicable');
});
