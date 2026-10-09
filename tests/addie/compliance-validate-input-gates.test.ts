import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  getComplianceStoryboardById,
  runStoryboard,
  type ComplianceResult,
  type Storyboard,
  type TestScenario,
  type TestStepResult,
} from '@adcp/sdk/testing';
import {
  complianceResultToDbInput,
  deriveStoryboardStatuses,
} from '../../server/src/addie/services/compliance-testing.js';

const require = createRequire(import.meta.url);
const { buildTo } = require('../../scripts/build-compliance.cjs');
const { version } = require('../../package.json');
const sourceDir = path.resolve('static/compliance/source');
const targets = ['ctv-experience-validate-input', 'premium-display-canonical-validation'];
let bundleDir: string;

beforeAll(() => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'validate-input-gates-'));
  // Exercise the publication builder and SDK cache loader without rewriting
  // any immutable released bundle or depending on a stale local latest build.
  buildTo(bundleDir, version, sourceDir);
});

afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

function loadStoryboard(name: string, surface: string): Storyboard {
  const source = YAML.parse(readFileSync(path.join(sourceDir, 'universal', `${name}.yaml`), 'utf8'));
  if (surface === 'source') return source;
  const published = getComplianceStoryboardById(source.id, { complianceDir: bundleDir, version });
  expect(published).toBeDefined();
  expect(published!.adcp_version).toBe(version);
  // The loader stamps the release version. Omit only that transport setting
  // for offline injected clients; all authored gates, fixtures and checks stay.
  return { ...published!, adcp_version: undefined };
}

function runOptions(tools: string[], client: object) {
  return {
    agentTools: tools,
    _profile: { tools },
    _client: client,
  };
}

type ProjectedStep = TestStepResult & { step_id: string };

function complianceResult(storyboard: Storyboard, steps: ProjectedStep[]): ComplianceResult {
  return {
    agent_url: 'https://agent.example/mcp',
    adcp_version: version,
    agent_profile: { name: 'Test validator', tools: ['validate_input', 'comply_test_controller'] },
    // Deliberately stale failure labels: the adapter must grade step evidence.
    overall_status: 'failing',
    tracks: [{
      track: 'creative',
      label: 'Creative',
      status: 'fail',
      duration_ms: 1,
      skipped_scenarios: [],
      observations: [],
      scenarios: [{
        agent_url: 'https://agent.example/mcp',
        // The runner emits storyboard/phase IDs beyond the legacy scenario enum.
        scenario: `${storyboard.id}/${storyboard.phases[0].id}` as TestScenario,
        overall_passed: false,
        steps,
        summary: 'Failed',
        total_duration_ms: 1,
        tested_at: '2026-09-15T00:00:00.000Z',
      }],
    }],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 0, tracks_failed: 1, tracks_skipped: 0,
      tracks_partial: 0, tracks_silent: 0, headline: 'Failed',
    },
    observations: [],
    notices: [],
    total_duration_ms: 1,
    tested_at: '2026-09-15T00:00:00.000Z',
  };
}

describe.each(['source', 'published bundle'])('3.2 validate_input gates: %s', surface => {
  describe.each(targets)('%s', name => {
    it('excludes controller-only agents and keeps the validator gate separate from controller setup', async () => {
      const storyboard = loadStoryboard(name, surface);
      expect(storyboard.introduced_in).toBe('3.2');
      expect(storyboard.required_tools).toEqual(['validate_input']);
      expect(storyboard.requires).toEqual(['controller']);
      expect(storyboard.prerequisites?.controller_seeding).toBe(true);
      const validateInput = vi.fn();
      const complyTestController = vi.fn();
      const executeTask = vi.fn();
      const client = { resetContext() {}, validateInput, complyTestController, executeTask };

      const excluded = await runStoryboard('https://agent.example/mcp', storyboard,
        runOptions(['comply_test_controller'], client));
      expect(excluded.phases[0].steps[0].skip_reason).toBe('missing_tool');
      expect(excluded.failed_count).toBe(0);

      const needsFixtures = await runStoryboard('https://agent.example/mcp', storyboard,
        runOptions(['validate_input'], client));
      expect(needsFixtures.phases[0].steps[0].skip_reason).toBe('missing_test_controller');
      expect(needsFixtures.failed_count).toBe(0);
      expect(validateInput).not.toHaveBeenCalled();
      expect(complyTestController).not.toHaveBeenCalled();
      expect(executeTask).not.toHaveBeenCalled();
    });

    it('executes the validator with setup available and preserves a genuine validation failure', async () => {
      const storyboard = loadStoryboard(name, surface);
      // Use the real positive vector and its validations. Fixtures are treated
      // as pre-seeded so this test isolates validator evidence from transport.
      const phase = storyboard.phases[0];
      const step = phase.steps[0];
      const focused = { ...storyboard, phases: [{ ...phase, steps: [step] }] };
      const validateInput = vi.fn(async (_task: string, request: { targets: unknown[]; context?: unknown }) => ({
        success: true,
        data: {
          adcp_version: '3.2',
          status: 'completed',
          context: request.context,
          results: [{ target: request.targets[0], result_kind: 'validated_pass' }],
        },
      }));
      const options = {
        ...runOptions(['validate_input', 'comply_test_controller'], { resetContext() {}, executeTask: validateInput }),
        skip_controller_seeding: true,
      };
      const passed = await runStoryboard('https://agent.example/mcp', focused, options);
      expect(validateInput).toHaveBeenCalledTimes(1);
      expect(validateInput.mock.calls[0][0]).toBe('validate_input');
      expect(passed.overall_passed).toBe(true);
      expect(passed.failed_count).toBe(0);
      expect(passed.passed_count).toBe(1);

      validateInput.mockImplementationOnce(async (_task, request) => ({
        success: true,
        data: {
          adcp_version: '3.2',
          status: 'completed',
          context: request.context,
          results: [{
            target: request.targets[0], result_kind: 'validated_fail',
            violations: [{ rule: 'manifest_structure', field: 'manifest.assets' }],
          }],
        },
      }));
      const failed = await runStoryboard('https://agent.example/mcp', focused, options);
      expect(validateInput).toHaveBeenCalledTimes(2);
      expect(failed.overall_passed).toBe(false);
      expect(failed.failed_count).toBe(1);
      const failure = failed.phases[0].steps[0];
      expect(failure.validations).toEqual(expect.arrayContaining([
        expect.objectContaining({ check: 'response_schema', passed: true }),
        expect.objectContaining({ check: 'field_value', passed: false }),
      ]));
      const result = complianceResult(storyboard, [{
        step: failure.title, step_id: failure.step_id, task: failure.task,
        passed: failure.passed, error: failure.error, duration_ms: failure.duration_ms,
      }]);
      expect(deriveStoryboardStatuses(result)[0]).toMatchObject({
        status: 'failing', failure_count: 1, first_failed_step_task: 'validate_input',
      });
      expect(complianceResultToDbInput(result, result.agent_url, 'production').tracks_json[0].status).toBe('fail');
    });

    it('keeps fixture-unavailable coverage untested without masking independent validator failures', () => {
      const storyboard = loadStoryboard(name, surface);
      const [first, second] = storyboard.phases[0].steps;
      // SDK projected preflight gap plus its dependent skip; no seller verdict.
      const gapSteps: ProjectedStep[] = [{
        step: first.title, step_id: first.id, task: first.task,
        passed: false, skipped: true, skip_reason: 'fixture_unavailable', duration_ms: 0,
      }, {
        step: second.title, step_id: second.id, task: second.task,
        passed: false, skipped: true, skip_reason: 'prerequisite_failed', duration_ms: 0,
      }];
      const result = complianceResult(storyboard, gapSteps);
      expect(deriveStoryboardStatuses(result)).toEqual([{
        storyboard_id: storyboard.id, status: 'untested', steps_passed: 0, steps_total: 0,
      }]);
      expect(complianceResultToDbInput(result, result.agent_url, 'production').tracks_json[0]).toMatchObject({
        status: 'skip', has_coverage_gap_skip: true,
      });

      const mixed = complianceResult(storyboard, [{
        step: first.title, step_id: first.id, task: 'validate_input',
        passed: false, error: 'Expected validated_pass, received validated_fail', duration_ms: 1,
      }, ...gapSteps]);
      expect(deriveStoryboardStatuses(mixed)[0]).toMatchObject({ status: 'failing', failure_count: 1 });
      expect(complianceResultToDbInput(mixed, mixed.agent_url, 'production').tracks_json[0].status).toBe('fail');
    });
  });
});
