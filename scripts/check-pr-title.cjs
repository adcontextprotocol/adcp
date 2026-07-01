#!/usr/bin/env node

const title = (process.argv.slice(2).join(' ') || process.env.PR_TITLE || '').trim();

if (!title) {
  console.error('PR title is empty.');
  process.exit(1);
}

const disallowedAgentPrefix =
  /^\[(codex|claude|claude-code|openai|chatgpt|copilot|cursor|aider|devin|agent|ai)\](?:\s|:|-|$)/i;

if (disallowedAgentPrefix.test(title)) {
  console.error(`Invalid PR title: ${title}`);
  console.error('Remove the leading agent/tool prefix. Use a concrete conventional-commits title instead, for example:');
  console.error('  fix(changesets): block agent PR title prefixes');
  process.exit(1);
}

const conventionalCommit =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: .+/;

const allowedAutomationTitles = [/^Version Packages$/, /^Forward-merge\b/, /^chore: snapshot docs for v[0-9]/];

if (!conventionalCommit.test(title) && !allowedAutomationTitles.some((pattern) => pattern.test(title))) {
  console.log(
    '::notice title=PR title convention::Regular PR titles should use conventional-commits format, ' +
      'for example "fix(changesets): block agent PR title prefixes".',
  );
}
