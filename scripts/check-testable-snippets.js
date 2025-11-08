#!/usr/bin/env node
/**
 * Check for untested code snippets in git diff
 *
 * This script checks staged changes for new code blocks that aren't marked
 * as testable. It's designed to run as a pre-commit hook to ensure new
 * examples are tested.
 */

const { execSync } = require('child_process');
const fs = require('fs');

// Get the list of staged files
const stagedFiles = execSync('git diff --cached --name-only --diff-filter=AM', { encoding: 'utf8' })
  .split('\n')
  .filter(file => file.endsWith('.md') || file.endsWith('.mdx'));

if (stagedFiles.length === 0) {
  console.log('✓ No documentation files changed');
  process.exit(0);
}

// Languages that should be tested
const TESTABLE_LANGUAGES = ['javascript', 'typescript', 'python', 'bash', 'sh', 'shell'];

// Get diff for each file
let newUntestedSnippets = [];

for (const file of stagedFiles) {
  if (!file) continue;

  try {
    const diff = execSync(`git diff --cached -U0 ${file}`, { encoding: 'utf8' });

    // Find new code blocks (lines starting with +```language)
    const lines = diff.split('\n');
    let inAddedBlock = false;
    let currentSnippet = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for new code block
      if (line.startsWith('+```')) {
        const match = line.match(/^\+```(\w+)(.*)$/);
        if (match) {
          const language = match[1];
          const metadata = match[2];

          // Check if it's a testable language
          if (TESTABLE_LANGUAGES.includes(language.toLowerCase())) {
            // Check if it has test=true marker
            const hasTestMarker = /\btest=true\b/.test(metadata) || /\btestable\b/.test(metadata);

            if (!hasTestMarker) {
              currentSnippet = {
                file,
                language,
                line: i + 1,
                isComplete: false
              };
              inAddedBlock = true;
            }
          }
        }
      }

      // Track if this looks like a complete example (has imports/requires)
      if (inAddedBlock && currentSnippet) {
        if (line.match(/^\+(import|from|require|const|let|var|function|def|class|async)/)) {
          currentSnippet.isComplete = true;
        }
      }

      // End of code block
      if (inAddedBlock && line.startsWith('+```') && currentSnippet && currentSnippet.line !== i + 1) {
        // Only warn about complete-looking examples
        if (currentSnippet.isComplete) {
          newUntestedSnippets.push(currentSnippet);
        }
        inAddedBlock = false;
        currentSnippet = null;
      }
    }
  } catch (error) {
    // File might not exist in previous commit (new file)
    if (!error.message.includes('exists on disk, but not in')) {
      console.error(`Warning: Could not check ${file}:`, error.message);
    }
  }
}

if (newUntestedSnippets.length === 0) {
  console.log('✓ No new untested code snippets found');
  process.exit(0);
}

// Report findings
console.log('\n⚠️  Found new untested code snippets:\n');
for (const snippet of newUntestedSnippets) {
  console.log(`  ${snippet.file}:${snippet.line} (${snippet.language})`);
}

console.log('\n💡 Consider marking these snippets as testable:');
console.log('   Add "test=true" after the language identifier:');
console.log('   ```javascript test=true\n');
console.log('📖 See docs/contributing/testable-snippets.md for guidelines\n');

// Exit with warning (0) rather than error (1) so commit isn't blocked
// This is a soft warning to encourage testing, not a hard requirement
process.exit(0);
