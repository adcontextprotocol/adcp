#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [path.join(repoRoot, 'docs')];

function collectMdxFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMdxFiles(filePath));
    else if (entry.isFile() && entry.name.endsWith('.mdx')) files.push(filePath);
  }
  return files;
}

const parser = unified().use(remarkParse).use(remarkMdx);
const files = roots.flatMap(collectMdxFiles);
const failures = [];

for (const filePath of files) {
  try {
    parser.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    failures.push(`${path.relative(repoRoot, filePath)}: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error(`MDX syntax validation failed for ${failures.length} file(s):`);
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`MDX syntax valid for ${files.length} current documentation page(s).`);
