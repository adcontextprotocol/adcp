#!/usr/bin/env node
/**
 * Analyze code snippets across documentation to identify untested blocks
 */

const fs = require('fs');
const path = require('path');

const DOCS_BASE_DIR = path.join(__dirname, '../docs');

function findDocFiles(dir = DOCS_BASE_DIR) {
  let files = [];
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      files = files.concat(findDocFiles(fullPath));
    } else if (item.endsWith('.md') || item.endsWith('.mdx')) {
      files.push(fullPath);
    }
  }

  return files;
}

function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(DOCS_BASE_DIR, filePath);

  // Find all code blocks
  const codeBlockRegex = /```(\w+)([^\n]*)\n([\s\S]*?)```/g;
  let match;
  let totalBlocks = 0;
  let testedBlocks = 0;
  let languages = new Set();

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = match[1];
    const metadata = match[2];
    const isTested = /\btest=true\b/.test(metadata) || /\btestable\b/.test(metadata);

    totalBlocks++;
    if (isTested) testedBlocks++;

    if (['javascript', 'typescript', 'python', 'bash', 'sh'].includes(language.toLowerCase())) {
      languages.add(language.toLowerCase());
    }
  }

  return {
    path: relativePath,
    totalBlocks,
    testedBlocks,
    untestedBlocks: totalBlocks - testedBlocks,
    languages: Array.from(languages),
    hasMixedLanguages: languages.size > 1
  };
}

const files = findDocFiles();
const results = files.map(analyzeFile).filter(r => r.totalBlocks > 0);

// Sort by untested blocks
results.sort((a, b) => b.untestedBlocks - a.untestedBlocks);

console.log('\n📊 Documentation Snippet Analysis\n');
console.log('Top 15 files with untested code snippets:\n');
results.slice(0, 15).forEach((r, i) => {
  console.log(`${(i + 1)}. ${r.path}`);
  console.log(`   Total: ${r.totalBlocks}, Tested: ${r.testedBlocks}, Untested: ${r.untestedBlocks}`);
  if (r.languages.length > 0) {
    console.log(`   Languages: ${r.languages.join(', ')}`);
  }
  console.log('');
});

const totals = results.reduce((acc, r) => ({
  totalBlocks: acc.totalBlocks + r.totalBlocks,
  testedBlocks: acc.testedBlocks + r.testedBlocks
}), { totalBlocks: 0, testedBlocks: 0 });

console.log(`\n📈 Overall Statistics:`);
console.log(`Total code blocks: ${totals.totalBlocks}`);
console.log(`Tested: ${totals.testedBlocks} (${(totals.testedBlocks / totals.totalBlocks * 100).toFixed(1)}%)`);
console.log(`Untested: ${totals.totalBlocks - totals.testedBlocks} (${((totals.totalBlocks - totals.testedBlocks) / totals.totalBlocks * 100).toFixed(1)}%)`);
