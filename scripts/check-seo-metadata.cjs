#!/usr/bin/env node
/**
 * Validate SEO metadata on all MDX documentation pages.
 *
 * Checks:
 * - ERROR: Missing `description` frontmatter (required)
 * - ERROR: Missing `"og:title"` frontmatter (required)
 * - ERROR: Has deprecated `keywords` field (remove it)
 * - WARN:  Description exceeds 160 characters
 * - WARN:  og:title exceeds 60 characters
 * - WARN:  Page has walkthrough/concept images but no `og:image`
 *
 * Exit codes:
 *   0 = pass (warnings only or clean)
 *   1 = fail (errors found)
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const MAX_DESCRIPTION_LENGTH = 160;
const MAX_OG_TITLE_LENGTH = 60;
const IMAGE_PATTERN = /\/images\/(walkthrough|concepts)\//;

function findMdxFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdxFiles(fullPath));
    } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    // Handle quoted keys like "og:image": value
    const quoted = line.match(/^"([^"]+)"\s*:\s*(.+)/);
    if (quoted) {
      fm[quoted[1].trim()] = quoted[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // Handle unquoted keys like title: value
    const unquoted = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.+)/);
    if (unquoted) {
      fm[unquoted[1].trim()] = unquoted[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

function hasIllustrations(content) {
  return IMAGE_PATTERN.test(content);
}

const files = findMdxFiles(DOCS_DIR);
const errors = [];
const warnings = [];

const stats = {
  total: files.length,
  hasDescription: 0,
  hasOgTitle: 0,
  hasOgImage: 0,
  hasIllustrations: 0,
};

for (const file of files) {
  const relPath = path.relative(path.join(__dirname, '..'), file);
  const content = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(content);
  const illustrated = hasIllustrations(content);

  if (illustrated) stats.hasIllustrations++;

  // Check description (required)
  if (!fm.description) {
    errors.push(`${relPath}: missing description`);
  } else {
    stats.hasDescription++;
    if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
      warnings.push(`${relPath}: description is ${fm.description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`);
    }
  }

  // Check og:title (required)
  if (!fm['og:title']) {
    errors.push(`${relPath}: missing og:title`);
  } else {
    stats.hasOgTitle++;
    if (fm['og:title'].length > MAX_OG_TITLE_LENGTH) {
      warnings.push(`${relPath}: og:title is ${fm['og:title'].length} chars (max ${MAX_OG_TITLE_LENGTH})`);
    }
  }

  // Check for deprecated keywords field
  if (fm.keywords) {
    errors.push(`${relPath}: has deprecated keywords field (remove it — Google ignores it)`);
  }

  // Check og:image on illustrated pages
  if (fm['og:image']) {
    stats.hasOgImage++;
  } else if (illustrated) {
    warnings.push(`${relPath}: has illustrations but no og:image`);
  }
}

// Report
console.log('\n📊 SEO Metadata Report');
console.log('═'.repeat(50));
console.log(`Total pages:        ${stats.total}`);
console.log(`With description:   ${stats.hasDescription}/${stats.total}`);
console.log(`With og:title:      ${stats.hasOgTitle}/${stats.total}`);
console.log(`With og:image:      ${stats.hasOgImage}/${stats.total}`);
console.log(`Illustrated pages:  ${stats.hasIllustrations}`);

if (errors.length > 0) {
  console.log(`\n❌ Errors (${errors.length}):`);
  for (const e of errors) console.log(`  ${e}`);
}

if (warnings.length > 0) {
  console.log(`\n⚠️  Warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  ${w}`);
}

if (errors.length === 0 && warnings.length === 0) {
  console.log('\n✅ All pages have required SEO metadata');
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);
