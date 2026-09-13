import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = fs.readFileSync(
  path.join(root, '.agents/routines/triage-prompt.md'),
  'utf8',
);
const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/claude-issue-triage.yml'),
  'utf8',
);
const recoveryWorkflow = fs.readFileSync(
  path.join(root, '.github/workflows/triage-webhook-miss-sweep.yml'),
  'utf8',
);

test('triage requires issue milestone writeback and exact readback', () => {
  expect(prompt).toMatch(/gh issue edit <N>.*--milestone "\$selected_milestone"/);
  expect(prompt).toMatch(/gh issue view <N>.*--json milestone/);
  expect(prompt).toMatch(/readback must equal the selected title exactly/i);
  expect(prompt).toMatch(/RFCs, epics, and deferred issues still receive issue milestones/);
  expect(prompt).not.toMatch(
    /On RFC \/ epic \/ deferred issues:\*\* omit the milestone line/,
  );
  expect(prompt).not.toMatch(
    /blocked on prerequisite work\. Apply `claude-triaged` \+ relevant/,
  );
  expect(prompt).not.toMatch(
    /Skip expert\s+consultation\. Apply `claude-triaged` \+ appropriate/,
  );
  expect(prompt).not.toMatch(
    /If \*\*any\*\* of these is true, apply\s+`claude-triaged` silently and move on/,
  );
  expect(prompt).not.toMatch(/`\/triage defer` — force defer and stop/);
  expect(prompt).toMatch(
    /Step 6 — Route and verify the issue milestone[\s\S]*Step 7 — Comment/,
  );
  expect(prompt).toMatch(
    /gh issue view <N>.*--json milestone --jq[\s\S]*\.milestone\.title/,
  );
});

test('event payload repeats the milestone writeback gate', () => {
  expect(workflow).toMatch(/MILESTONE WRITEBACK REQUIRED:/);
  expect(workflow).toMatch(/read it back with `gh issue view --json milestone`/);
  expect(workflow).toMatch(/before applying `claude-triaged`/);
  expect(workflow).toMatch(/MILESTONE AUTHORITY:.*restricted authority/i);
  expect(workflow).toMatch(/cannot replace an existing milestone/);
  expect(workflow).toMatch(/cannot replace an existing milestone or select P0 Bugs/);
  expect(prompt).toMatch(/initial.*empty milestone[\s\S]*cannot overwrite/i);
  expect(prompt).toMatch(/do \*\*not\*\* apply `claude-triaged`/);
});

test('workflow fences all issue prose and derives milestone authority from metadata', () => {
  expect(workflow).toMatch(/<<<UNTRUSTED_ISSUE_TITLE/);
  expect(workflow).toMatch(/<<<UNTRUSTED_ISSUE_BODY/);
  expect(workflow).toMatch(/<<<UNTRUSTED_NEW_COMMENT_BODY/);
  expect(workflow).toMatch(/untrusted_boundary=\$\(openssl rand -hex 16\)/);
  expect(workflow).toMatch(/END_UNTRUSTED_ISSUE_BODY_" \+ \$untrusted_boundary/);
  expect(workflow).toMatch(/trigger_assoc="\$comment_assoc"/);
  expect(workflow).toMatch(/OWNER\|MEMBER\|COLLABORATOR/);
  expect(prompt).toMatch(/never infer authorization[\s\S]{0,40}claims/i);
});

test('missed-webhook recovery preserves auto-intake milestone guarantees', () => {
  expect(recoveryWorkflow).toMatch(/Current milestone:/);
  expect(recoveryWorkflow).toMatch(/MILESTONE AUTHORITY: initial/);
  expect(recoveryWorkflow).toMatch(/MILESTONE WRITEBACK REQUIRED:/);
  expect(recoveryWorkflow).toMatch(/<<<UNTRUSTED_ISSUE_TITLE_/);
  expect(recoveryWorkflow).toMatch(/<<<UNTRUSTED_ISSUE_BODY_/);
  expect(recoveryWorkflow).toMatch(/untrusted_boundary=\$\(openssl rand -hex 16\)/);
  expect(recoveryWorkflow).toMatch(
    /END_UNTRUSTED_ISSUE_BODY_" \+ \$untrusted_boundary/,
  );
  expect(recoveryWorkflow).not.toMatch(/Issue: #" \+ \$num \+ " \\\"/);
  expect(recoveryWorkflow).toMatch(/contains\(\["needs-wg-review"\]\)/);
});
