import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = { name: string; if?: string; run?: string };
type Concurrency = { group: string; 'cancel-in-progress': boolean };
type Workflow = { concurrency?: Concurrency; jobs: Record<string, { if: string; steps: Step[]; concurrency?: Concurrency }> };
const readWorkflow = (name: string): Workflow => parse(readFileSync(
  new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8',
));
const deploy = readWorkflow('deploy');
const provision = readWorkflow('provision-matched-v4-evaluator');
const repository = 'adcontextprotocol/adcp';

// These workflow conditions use the common boolean/equality subset of JS and
// GitHub expressions. Evaluate the actual checked-in conditions against events.
function accepts(mode: string, name = 'Build Check', event = 'push', overrides = {}) {
  return runInNewContext(deploy.jobs.preflight.if, {
    vars: { ADDIE_MATCHED_V4_EVALUATOR_DEPLOY_ENABLED: mode },
    github: { repository, event: { workflow_run: {
      name, event, conclusion: 'success', head_branch: 'main',
      head_repository: { full_name: repository }, ...overrides,
    } } },
  }, { timeout: 100 });
}

describe('application and protected evaluator deployment', () => {
  it.each([
    [0, 0, 2, 0],
    [42, 0, 1, 42],
    [0, 43, 2, 43],
  ])('replaces web before updating the worker and stops on failure (%s, %s)', (webExit, workerExit, calls, expectedExit) => {
    const script = deploy.jobs.deploy.steps.find(step => step.name === 'Deploy')!.run!;
    const start = script.indexOf('          set +e'.trim());
    const end = script.indexOf('deploy_exit=$?', start) + 'deploy_exit=$?'.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const output = execFileSync('bash', ['-c', `
      flyctl() {
        printf '%s\\n' "$*"
        case " $* " in
          *" --process-groups web "*) return ${webExit} ;;
          *" --process-groups worker "*) return ${workerExit} ;;
          *) return 99 ;;
        esac
      }
      ${script.slice(start, end)}
      printf 'exit=%s\\n' "$deploy_exit"
    `], { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '2' } });
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(calls + 1);
    expect(lines[0]).toContain('--process-groups web --strategy bluegreen');
    expect(lines[0]).toContain('--image-label app-abc123-17-2');
    expect(lines[0]).not.toContain('--skip-release-command');
    if (calls === 2) {
      expect(lines[1]).toContain('--image registry.fly.io/adcp-docs:app-abc123-17-2');
      expect(lines[1]).toContain('--process-groups worker --strategy rolling --skip-release-command');
    }
    expect(lines.at(-1)).toBe(`exit=${expectedExit}`);
  });

  it('reserves the deploy slot only for jobs accepted by preflight', () => {
    expect(deploy.concurrency).toBeUndefined();
    expect(deploy.jobs.preflight.concurrency).toBeUndefined();
    expect(deploy.jobs.deploy.concurrency).toEqual({
      group: 'fly-deploy', 'cancel-in-progress': false,
    });
  });

  it.each(['', 'false'])('deploys successful main builds in ordinary mode %j', mode => {
    expect(accepts(mode)).toBe(true);
    expect(accepts(mode, 'Provision matched-v4 evaluator schema', 'workflow_run')).toBe(false);
  });

  it('waits for the protected workflow when evaluator deployment is enabled', () => {
    expect(accepts('true')).toBe(false);
    expect(accepts('true', 'Provision matched-v4 evaluator schema', 'workflow_run')).toBe(true);
  });

  it.each([
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    { head_branch: 'feature' }, { head_repository: { full_name: 'untrusted/fork' } },
  ])('rejects untrusted or unsuccessful events: %j', overrides => {
    expect(accepts('', 'Build Check', 'push', overrides)).toBe(false);
    expect(accepts('true', 'Provision matched-v4 evaluator schema', 'workflow_run', overrides)).toBe(false);
  });

  it('rejects wrong event types, other workflows, and invalid rollout settings', () => {
    expect(accepts('', 'Build Check', 'pull_request')).toBe(false);
    expect(accepts('', 'Build Check', 'workflow_dispatch')).toBe(false);
    expect(accepts('', 'Another workflow')).toBe(false);
    expect(accepts('true', 'Provision matched-v4 evaluator schema', 'push')).toBe(false);
    expect(accepts('typo')).toBe(false);
  });

  it.each([
    ['true', 'false', '', true], ['false', 'false', '', false],
    ['true', 'true', '', false], ['true', 'true', 'false', false],
    ['true', 'true', 'true', true], ['false', 'true', 'true', false],
  ])('requires current main and the selected prerequisite: %s/%s/%s',
    (deploy_current, evaluator_required, evaluator_provisioned, allowed) => {
      expect(runInNewContext(deploy.jobs.deploy.if, {
        needs: { preflight: { outputs: { deploy_current, evaluator_required, evaluator_provisioned } } },
      }, { timeout: 100 })).toBe(allowed);
    });

  it.each(['', 'false', 'typo', 'true'])('acquires operator environment only on opt-in: %j', mode => {
    expect(runInNewContext(provision.jobs.provision.if, {
      vars: { ADDIE_MATCHED_V4_EVALUATOR_DEPLOY_ENABLED: mode },
    }, { timeout: 100 })).toBe(mode === 'true');
  });

  it('stages mutually exclusive runtime settings before deployment', () => {
    const steps = deploy.jobs.deploy.steps;
    const ordinary = steps.find(s => s.name === 'Disable evaluator admission for ordinary app release')!;
    const protectedStep = steps.find(s => s.name === 'Stage exact matched-v4 admission SHA for ordinary runtime')!;
    const recheck = steps.find(s => s.name === 'Recheck triggering evaluator provision immediately before protected deploy use')!;
    for (const mode of ['true', 'false']) {
      const context = { needs: { preflight: { outputs: { evaluator_required: mode } } } };
      expect(runInNewContext(ordinary.if!, context, { timeout: 100 })).toBe(mode === 'false');
      expect(runInNewContext(protectedStep.if!, context, { timeout: 100 })).toBe(mode === 'true');
      expect(runInNewContext(recheck.if!, context, { timeout: 100 })).toBe(mode === 'true');
    }
    const staged = (step: Step) => execFileSync('bash', ['-c',
      `flyctl() { printf '%s\\n' "$@"; }\n${step.run}`,
    ], { encoding: 'utf8', env: { PATH: process.env.PATH, TESTED_SHA: 'a'.repeat(40) } }).trim().split('\n');
    expect(staged(ordinary)).toEqual(['secrets', 'set', '--stage',
      'ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED=false', 'ADDIE_MATCHED_V4_MERGE_SHA=disabled']);
    expect(staged(protectedStep)).toEqual(['secrets', 'set', '--stage',
      `ADDIE_MATCHED_V4_MERGE_SHA=${'a'.repeat(40)}`, 'ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED=true']);
    const deployIndex = steps.findIndex(s => s.name === 'Deploy');
    expect(steps.indexOf(ordinary)).toBeLessThan(deployIndex);
    expect(steps.indexOf(protectedStep)).toBeLessThan(deployIndex);
    expect(steps.indexOf(recheck)).toBeLessThan(steps.indexOf(protectedStep));
  });
});
