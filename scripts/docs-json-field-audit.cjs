#!/usr/bin/env node
/**
 * Advisory audit for unknown public fields in schema-backed docs JSON examples.
 *
 * JSON Schema intentionally leaves many protocol objects extensible at the wire
 * level. Docs examples are different: unknown public-looking fields often mean
 * stale documentation. This reporter flags those fields without failing by
 * default; pass --check to make findings gating.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const SCHEMAS_DIR = path.join(ROOT, 'static', 'schemas', 'source');

const args = process.argv.slice(2);
const format = args.includes('--json')
  ? 'json'
  : args.includes('--markdown')
    ? 'markdown'
    : 'text';
const check = args.includes('--check');
const updateBaseline = args.includes('--update-baseline');
const topN = Number.parseInt(readArg('--top', '25'), 10);
const baselinePath = path.resolve(readArg(
  '--baseline',
  path.join(ROOT, 'scripts', 'docs-json-field-audit-baseline.json')
));

const FLEXIBLE_FIELD_NAMES = new Set([
  'context',
  'data',
  'details',
  'ext',
  'extensions',
  'fields',
  'metadata',
  'params',
  'platform_extensions'
]);

function readArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

function walkFiles(dir, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, predicate));
    } else if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function loadSchemas() {
  const schemas = new Map();
  for (const file of walkFiles(SCHEMAS_DIR, (f) => f.endsWith('.json'))) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    tagSchemaNodes(schema, schema);
    const rel = path.relative(SCHEMAS_DIR, file).replace(/\\/g, '/');
    const id = schema.$id || `/schemas/${rel}`;
    for (const key of schemaKeys(id, rel)) {
      schemas.set(key, schema);
    }
  }
  return schemas;
}

function tagSchemaNodes(node, root) {
  if (!node || typeof node !== 'object') return;
  Object.defineProperty(node, '__root', {
    value: root,
    enumerable: false,
    configurable: false
  });

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      tagSchemaNodes(value, root);
    }
  }
}

function resolveJsonPointer(root, pointer) {
  const parts = pointer
    .replace(/^#/, '')
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return null;
    current = current[part];
  }
  return current || null;
}

function schemaKeys(id, rel) {
  const bare = id.replace(/^\/schemas\//, '');
  return [
    id,
    `/schemas/${bare}`,
    `/schemas/latest/${bare}`,
    `https://adcontextprotocol.org/schemas/${bare}`,
    `https://adcontextprotocol.org/schemas/latest/${bare}`,
    path.join(SCHEMAS_DIR, rel)
  ];
}

function normalizeSchemaUri(uri) {
  let schemaPath = uri.replace(/^https?:\/\/[^/]+/, '');
  schemaPath = schemaPath.replace(/^\/schemas\/latest\//, '/schemas/');
  schemaPath = schemaPath.replace(/^\/schemas\/v\d+(?:\.\d+)*(?:-[^/]+)?\//, '/schemas/');
  return schemaPath;
}

function isAdcpSchemaUri(uri) {
  return uri.startsWith('/schemas/') ||
    /^https?:\/\/adcontextprotocol\.org\/schemas\//.test(uri);
}

function extractJsonBlocks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = [];
  const codeBlockRegex = /```json[^\n]*\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const code = match[1].trim();
    const line = content.substring(0, match.index).split('\n').length;

    if (/\[\.\.\.\]|\{\.\.\.\}|\.\.\./.test(code)) {
      blocks.push({ file: filePath, line, code, kind: 'placeholder' });
      continue;
    }

    try {
      const parsed = JSON.parse(code);
      blocks.push({
        file: filePath,
        line,
        code,
        parsed,
        kind: parsed && typeof parsed === 'object' && typeof parsed.$schema === 'string'
          ? 'schema'
          : 'plain'
      });
    } catch (error) {
      blocks.push({ file: filePath, line, code, kind: 'invalid', error: error.message });
    }
  }

  return blocks;
}

function deref(schema, schemas, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || !schema.$ref) return schema;
  const ref = schema.$ref.startsWith('#')
    ? schema.$ref
    : normalizeSchemaUri(schema.$ref);
  if (seen.has(ref)) return schema;
  const resolved = schema.$ref.startsWith('#')
    ? resolveJsonPointer(schema.__root || schema, schema.$ref)
    : schemas.get(ref);
  if (!resolved) return schema;
  seen.add(ref);
  return deref(resolved, schemas, seen);
}

function childSchemas(schema, schemas) {
  const resolved = deref(schema, schemas);
  if (!resolved || typeof resolved !== 'object') return [];
  const children = [];
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(resolved[key])) {
      children.push(...resolved[key].map((child) => deref(child, schemas)));
    }
  }
  return children;
}

function collectObjectContract(schema, schemas, seen = new Set()) {
  const resolved = deref(schema, schemas);
  if (!resolved || typeof resolved !== 'object') {
    return { properties: new Map(), patterns: [] };
  }

  const marker = resolved.$id || JSON.stringify(Object.keys(resolved).sort());
  if (seen.has(marker)) {
    return { properties: new Map(), patterns: [] };
  }
  seen.add(marker);

  const properties = new Map();
  const patterns = [];

  if (resolved.properties && typeof resolved.properties === 'object') {
    for (const [key, value] of Object.entries(resolved.properties)) {
      if (!properties.has(key)) properties.set(key, []);
      properties.get(key).push(value);
    }
  }

  if (resolved.patternProperties && typeof resolved.patternProperties === 'object') {
    for (const pattern of Object.keys(resolved.patternProperties)) {
      patterns.push(pattern);
    }
  }

  for (const child of childSchemas(resolved, schemas)) {
    const childContract = collectObjectContract(child, schemas, new Set(seen));
    for (const [key, values] of childContract.properties.entries()) {
      if (!properties.has(key)) properties.set(key, []);
      properties.get(key).push(...values);
    }
    patterns.push(...childContract.patterns);
  }

  return { properties, patterns };
}

function matchesPattern(key, patterns) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(key);
    } catch {
      return false;
    }
  });
}

function schemaForProperty(schema, propertyName, schemas) {
  const contract = collectObjectContract(schema, schemas);
  const candidates = contract.properties.get(propertyName) || [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return { anyOf: candidates };
}

function schemaForItems(schema, schemas) {
  const resolved = deref(schema, schemas);
  if (!resolved || typeof resolved !== 'object') return null;
  if (resolved.items) return resolved.items;

  for (const child of childSchemas(resolved, schemas)) {
    const itemSchema = schemaForItems(child, schemas);
    if (itemSchema) return itemSchema;
  }

  return null;
}

function isFlexiblePath(jsonPath) {
  return jsonPath
    .split('.')
    .some((part) => FLEXIBLE_FIELD_NAMES.has(part.replace(/\[\d+\]$/, '')));
}

function auditValue({ value, schema, schemas, jsonPath, findings }) {
  const resolved = deref(schema, schemas);
  if (!resolved || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    const itemSchema = schemaForItems(resolved, schemas);
    if (!itemSchema) return;
    value.forEach((item, index) => {
      auditValue({
        value: item,
        schema: itemSchema,
        schemas,
        jsonPath: `${jsonPath}[${index}]`,
        findings
      });
    });
    return;
  }

  if (isFlexiblePath(jsonPath)) return;

  const contract = collectObjectContract(resolved, schemas);
  if (contract.properties.size > 0) {
    for (const key of Object.keys(value)) {
      if (jsonPath === '$' && key === '$schema') continue;
      if (FLEXIBLE_FIELD_NAMES.has(key)) continue;
      if (contract.properties.has(key)) continue;
      if (matchesPattern(key, contract.patterns)) continue;

      findings.push({
        path: jsonPath,
        field: key,
        message: `Unknown field ${jsonPath}.${key}`
      });
    }
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (jsonPath === '$' && key === '$schema') continue;
    const childSchema = schemaForProperty(resolved, key, schemas);
    if (!childSchema) continue;
    auditValue({
      value: childValue,
      schema: childSchema,
      schemas,
      jsonPath: jsonPath === '$' ? `$.${key}` : `${jsonPath}.${key}`,
      findings
    });
  }
}

function runAudit() {
  const schemas = loadSchemas();
  const docs = walkFiles(DOCS_DIR, (f) => /\.(md|mdx)$/.test(f));
  const findings = [];
  let schemaBackedBlocks = 0;

  for (const file of docs) {
    for (const block of extractJsonBlocks(file)) {
      if (block.kind !== 'schema') continue;
      if (!isAdcpSchemaUri(block.parsed.$schema)) continue;
      schemaBackedBlocks++;

      const schemaUri = normalizeSchemaUri(block.parsed.$schema);
      const schema = schemas.get(schemaUri);
      if (!schema) {
        findings.push({
          file: path.relative(ROOT, file),
          line: block.line,
          schema: block.parsed.$schema,
          path: '$',
          field: '$schema',
          message: `Schema not found: ${block.parsed.$schema}`
        });
        continue;
      }

      const blockFindings = [];
      auditValue({
        value: block.parsed,
        schema,
        schemas,
        jsonPath: '$',
        findings: blockFindings
      });

      for (const finding of blockFindings) {
        findings.push({
          file: path.relative(ROOT, file),
          line: block.line,
          schema: block.parsed.$schema,
          ...finding
        });
      }
    }
  }

  const byFile = new Map();
  for (const finding of findings) {
    byFile.set(finding.file, (byFile.get(finding.file) || 0) + 1);
  }

  const baseline = compareBaseline(findings);

  if (updateBaseline) {
    writeBaseline(findings);
    baseline.updated = true;
  }

  return {
    generatedAt: new Date().toISOString(),
    schemaBackedBlocks,
    findings: findings.slice(0, topN),
    totalFindings: findings.length,
    baseline,
    topFiles: [...byFile.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, topN)
  };
}

function findingKey(finding) {
  return [
    finding.file,
    finding.path,
    finding.field,
    finding.schema
  ].join('|');
}

function summarizeFindings(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, objectPath, field, schema] = key.split('|');
      return { file, path: objectPath, field, schema, count };
    })
    .sort((a, b) =>
      a.file.localeCompare(b.file) ||
      a.path.localeCompare(b.path) ||
      a.field.localeCompare(b.field) ||
      a.schema.localeCompare(b.schema)
    );
}

function readBaseline() {
  if (!fs.existsSync(baselinePath)) {
    return { exists: false, entries: [] };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  return {
    exists: true,
    entries: Array.isArray(baseline.entries) ? baseline.entries : []
  };
}

function writeBaseline(findings) {
  const baseline = {
    version: 1,
    updated_at: new Date().toISOString(),
    description: 'Baseline for docs-json-field-audit. CI fails only on findings whose key count exceeds this baseline.',
    entries: summarizeFindings(findings)
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function compareBaseline(findings) {
  const currentEntries = summarizeFindings(findings);
  const baseline = readBaseline();
  const baselineCounts = new Map(
    baseline.entries.map((entry) => [
      findingKey({
        file: entry.file,
        path: entry.path,
        field: entry.field,
        schema: entry.schema
      }),
      entry.count || 0
    ])
  );

  const newEntries = [];
  for (const entry of currentEntries) {
    const key = findingKey(entry);
    const allowed = baselineCounts.get(key) || 0;
    if (entry.count > allowed) {
      newEntries.push({ ...entry, allowed, new_count: entry.count - allowed });
    }
  }

  return {
    path: path.relative(ROOT, baselinePath),
    exists: baseline.exists,
    entries: baseline.entries.length,
    current_entries: currentEntries.length,
    new_entries: newEntries,
    new_findings: newEntries.reduce((sum, entry) => sum + entry.new_count, 0),
    updated: false
  };
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(
    h.length,
    ...rows.map((row) => String(row[i]).length)
  ));
  const line = (cols) => cols.map((col, i) => String(col).padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function renderText(report) {
  const findingRows = report.findings.map((finding) => [
    `${finding.file}:${finding.line}`,
    finding.path,
    finding.field,
    finding.schema
  ]);
  const topRows = report.topFiles.map((entry) => [entry.file, entry.count]);

  return [
    'Docs JSON Field Audit',
    '',
    `Schema-backed JSON blocks: ${report.schemaBackedBlocks}`,
    `Unknown-field findings: ${report.totalFindings}`,
    `Baseline: ${report.baseline.exists ? report.baseline.path : `${report.baseline.path} (missing)`}`,
    `New findings vs baseline: ${report.baseline.new_findings}`,
    '',
    'Top files',
    topRows.length ? table(['File', 'Findings'], topRows) : 'No findings.',
    '',
    `First ${report.findings.length} findings`,
    findingRows.length ? table(['Location', 'Object', 'Field', 'Schema'], findingRows) : 'No findings.'
  ].join('\n');
}

function renderMarkdown(report) {
  const lines = [
    '## Docs JSON Field Audit',
    '',
    `Schema-backed JSON blocks: **${report.schemaBackedBlocks}**`,
    `Unknown-field findings: **${report.totalFindings}**`,
    `Baseline: \`${report.baseline.path}\`${report.baseline.exists ? '' : ' (missing)'}`,
    `New findings vs baseline: **${report.baseline.new_findings}**`,
    '',
    '### Top Files',
    ''
  ];

  if (report.topFiles.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push('| File | Findings |', '|---|---:|');
    for (const entry of report.topFiles) {
      lines.push(`| \`${entry.file}\` | ${entry.count} |`);
    }
  }

  lines.push('', '### Sample Findings', '');
  if (report.findings.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push('| Location | Object | Field | Schema |', '|---|---|---|---|');
    for (const finding of report.findings) {
      lines.push(`| \`${finding.file}:${finding.line}\` | \`${finding.path}\` | \`${finding.field}\` | \`${finding.schema}\` |`);
    }
  }

  return lines.join('\n');
}

const report = runAudit();

if (format === 'json') {
  console.log(JSON.stringify(report, null, 2));
} else if (format === 'markdown') {
  console.log(renderMarkdown(report));
} else {
  console.log(renderText(report));
}

if (check && report.baseline.new_findings > 0) {
  process.exit(1);
}
