const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'server', 'src');

// These modules intentionally translate or preserve AdCP 3.x named-format
// wire shapes. Ordinary application modules must use canonical format kinds,
// options, and option references instead.
const LEGACY_FORMAT_BOUNDARIES = new Set([
  'server/src/addie/mcp/member-tools.ts',
  'server/src/creative-agent/preview-renderer.ts',
  'server/src/creative-agent/task-handlers.ts',
  'server/src/db/agent-inventory-profiles-db.ts',
  'server/src/routes/registry-api.ts',
  'server/src/shared/formats.ts',
  'server/src/training-agent/comply-test-controller.ts',
  'server/src/training-agent/product-factory.ts',
  'server/src/training-agent/task-handlers.ts',
  'server/src/training-agent/types.ts',
  'server/src/training-agent/v6-sales-platform.ts',
  'server/src/training-agent/tenants/creative-tools.ts',
  'server/src/training-agent/tenants/list-transformers-tool.ts',
]);

function typescriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [fullPath] : [];
  });
}

test('legacy named-format identity stays inside explicit compatibility boundaries', () => {
  const offenders = [];

  for (const file of typescriptFiles(SOURCE_ROOT)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (LEGACY_FORMAT_BOUNDARIES.has(relative)) continue;

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/\b(?:format_id|format_ids|input_format_ids|output_format_ids|target_format_id|target_format_ids)\b/.test(line)) {
        offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Legacy format identity escaped its compatibility boundary:\n${offenders.join('\n')}`,
  );
});
