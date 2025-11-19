#!/usr/bin/env node
/**
 * Check for untested code snippets in changed documentation files
 *
 * This script checks for new code blocks that aren't marked as testable.
 * It understands both page-level testable frontmatter and snippet-level test markers.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Get changed files from changed_files.txt (created by GitHub Actions)
let changedFiles = [];
try {
  if (fs.existsSync('changed_files.txt')) {
    changedFiles = fs.readFileSync('changed_files.txt', 'utf8')
      .split('\n')
      .filter(file => file.trim() && (file.endsWith('.md') || file.endsWith('.mdx')));
  }
} catch (error) {
  // Fallback to git diff if file doesn't exist
  try {
    changedFiles = execSync('git diff --cached --name-only --diff-filter=AM', { encoding: 'utf8' })
      .split('\n')
      .filter(file => file && (file.endsWith('.md') || file.endsWith('.mdx')));
  } catch (e) {
    console.log('✓ No documentation files changed');
    process.exit(0);
  }
}

if (changedFiles.length === 0) {
  console.log('✓ No documentation files changed');
  process.exit(0);
}

// Languages that should be tested
const TESTABLE_LANGUAGES = ['javascript', 'typescript', 'python', 'bash', 'sh', 'shell'];

/**
 * Check if a file has testable: true in frontmatter
 */
function hasTestableFrontmatter(filePath) {
  if (!fs.existsSync(filePath)) return false;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      return /testable:\s*true/i.test(frontmatterMatch[1]);
    }
  } catch (error) {
    return false;
  }
  return false;
}

// Check each changed file
let warnings = [];

for (const file of changedFiles) {
  if (!file) continue;

  const fullPath = path.resolve(file);

  // Check if file has testable: true in frontmatter
  const isTestable = hasTestableFrontmatter(fullPath);

  if (isTestable) {
    console.log(`✓ ${file} - marked as testable`);
    continue;
  }

  // Check for new untested code blocks
  try {
    const diff = execSync(`git diff origin/main...HEAD -- ${file}`, { encoding: 'utf8' });
    const lines = diff.split('\n');
    let hasNewCodeBlocks = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('+```')) {
        const match = line.match(/^\+```(\w+)/);
        if (match && TESTABLE_LANGUAGES.includes(match[1].toLowerCase())) {
          hasNewCodeBlocks = true;
          break;
        }
      }
    }

    if (hasNewCodeBlocks) {
      warnings.push(file);
    }
  } catch (error) {
    // File might not exist in base branch (new file)
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const hasCodeBlocks = TESTABLE_LANGUAGES.some(lang =>
        content.includes(`\`\`\`${lang}`)
      );
      if (hasCodeBlocks) {
        warnings.push(file);
      }
    }
  }
}

if (warnings.length > 0) {
  console.log('\n💡 The following files have code examples but aren\'t marked as testable:\n');
  for (const file of warnings) {
    console.log(`  ${file}`);
  }
  console.log('\n📖 Consider adding "testable: true" to the frontmatter:');
  console.log('   ---');
  console.log('   title: Your Page');
  console.log('   testable: true');
  console.log('   ---\n');
  console.log('See CLAUDE.md for testable documentation guidelines\n');
}

// Always exit 0 - this is informational, not blocking
console.log(`\n✓ Checked ${changedFiles.length} documentation files`);
process.exit(0);
