import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';

// The org's hosted runners are capped at 60 concurrent jobs shared across
// every AAO repo. These guards keep the heaviest PR workflows from spending
// that capacity on drafts and superseded commits.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8'));

describe('training-agent-storyboards.yml draft skipping', () => {
  const wf = load('training-agent-storyboards.yml');

  it('re-runs when a draft is marked ready for review', () => {
    expect(wf.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review']);
  });

  it('skips every job on draft PRs', () => {
    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(job.if, `${id} must skip drafts`).toContain('github.event.pull_request.draft != true');
    }
  });
});

describe.each([
  ['codeql.yml'],
  ['semgrep.yml'],
  ['broken-links.yml'],
  ['migration-smoke-test.yml'],
])('%s superseded-run cancellation', (name) => {
  const wf = load(name);

  it('cancels only pull_request runs, grouped per PR', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
    expect(wf.concurrency.group).toContain('github.event.pull_request.number');
    // Non-PR runs (push to main, schedule, workflow_run) each get a unique
    // group so they are never cancelled or evicted from a pending slot.
    expect(wf.concurrency.group).toContain('github.run_id');
  });
});
