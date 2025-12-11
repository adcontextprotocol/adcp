#!/usr/bin/env node
/**
 * Check that testable documentation examples throw errors instead of swallowing them.
 *
 * This script validates that code examples in documentation properly throw/raise
 * exceptions on error conditions rather than silently logging them.
 *
 * Usage:
 *   node tests/check-error-handling.js           # Check all testable files
 *   node tests/check-error-handling.js --fix     # Show what needs fixing
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const DOCS_BASE_DIR = path.join(__dirname, '../docs');

// Patterns that indicate error swallowing (bad)
const ERROR_SWALLOWING_PATTERNS = {
  javascript: [
    // console.error without throw
    /console\.error\s*\([^)]*(?:failed|error|Failed|Error)[^)]*\)/gi,
  ],
  python: [
    // print with error/failed without raise
    /print\s*\([^)]*(?:failed|error|Failed|Error)[^)]*\)/gi,
  ]
};

// Patterns that indicate proper error handling (good)
const PROPER_ERROR_PATTERNS = {
  javascript: [
    /throw\s+new\s+Error/,
    /throw\s+error/i,
  ],
  python: [
    /raise\s+Exception/,
    /raise\s+\w+Error/,
  ]
};

function extractCodeBlocks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = [];

  // Check if page has testable: true in frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const isTestablePage = frontmatterMatch && /testable:\s*true/i.test(frontmatterMatch[1]);

  if (!isTestablePage) {
    return blocks;
  }

  // Regex to match code blocks
  const codeBlockRegex = /```(\w+)([^\n]*)\n([\s\S]*?)```/g;

  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = match[1].toLowerCase();
    const metadata = match[2];
    const code = match[3];
    const line = content.substring(0, match.index).split('\n').length;

    // Skip explicitly disabled blocks
    if (/\btest=false\b/.test(metadata)) {
      continue;
    }

    if (language === 'javascript' || language === 'typescript' ||
        language === 'python' || language === 'py') {
      blocks.push({
        file: filePath,
        language: language === 'py' ? 'python' : language === 'typescript' ? 'javascript' : language,
        code,
        line
      });
    }
  }

  return blocks;
}

function checkBlock(block) {
  const issues = [];
  const lang = block.language === 'typescript' ? 'javascript' : block.language;

  const swallowPatterns = ERROR_SWALLOWING_PATTERNS[lang] || [];
  const properPatterns = PROPER_ERROR_PATTERNS[lang] || [];

  // Check for error swallowing patterns
  for (const pattern of swallowPatterns) {
    const matches = block.code.match(pattern);
    if (matches) {
      // Check if there's a corresponding throw/raise nearby
      const hasProperHandling = properPatterns.some(p => p.test(block.code));

      if (!hasProperHandling) {
        issues.push({
          pattern: matches[0].substring(0, 50),
          message: `Found error logging without throw/raise: "${matches[0].substring(0, 50)}..."`
        });
      }
    }
  }

  return issues;
}

function main() {
  const args = process.argv.slice(2);
  const showFix = args.includes('--fix');

  console.log('🔍 Checking error handling in testable documentation...\n');

  const docFiles = glob.sync('**/*.{md,mdx}', {
    cwd: DOCS_BASE_DIR,
    absolute: true
  });

  let totalIssues = 0;
  const fileIssues = {};

  for (const file of docFiles) {
    const blocks = extractCodeBlocks(file);

    for (const block of blocks) {
      const issues = checkBlock(block);

      if (issues.length > 0) {
        const relativePath = path.relative(DOCS_BASE_DIR, file);
        if (!fileIssues[relativePath]) {
          fileIssues[relativePath] = [];
        }

        for (const issue of issues) {
          fileIssues[relativePath].push({
            line: block.line,
            language: block.language,
            ...issue
          });
          totalIssues++;
        }
      }
    }
  }

  if (totalIssues === 0) {
    console.log('✅ All testable examples properly throw/raise on errors!\n');
    process.exit(0);
  }

  console.log(`❌ Found ${totalIssues} error handling issues:\n`);

  for (const [file, issues] of Object.entries(fileIssues)) {
    console.log(`\x1b[33m${file}\x1b[0m`);
    for (const issue of issues) {
      console.log(`  Line ${issue.line} (${issue.language}): ${issue.message}`);
    }
    console.log();
  }

  if (showFix) {
    console.log('\n📝 To fix these issues:');
    console.log('   JavaScript: Replace console.error() with throw new Error()');
    console.log('   Python: Replace print() with raise Exception()');
    console.log('\n   Example (JavaScript):');
    console.log('   - if (error) { console.error("Failed:", error); }');
    console.log('   + if (error) { throw new Error(`Failed: ${error}`); }');
    console.log('\n   Example (Python):');
    console.log('   - if error: print("Failed:", error)');
    console.log('   + if error: raise Exception(f"Failed: {error}")');
  }

  process.exit(1);
}

main();
