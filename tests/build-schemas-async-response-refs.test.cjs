#!/usr/bin/env node

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');

const { copyAsyncResponseRefsToCore } = require('../scripts/build-schemas.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function findJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(fullPath);
    }
  }
  return out;
}

function isOriginalAsyncResponse(root, filePath) {
  const rel = path.relative(root, filePath);
  if (rel.startsWith(`core${path.sep}async-response-refs${path.sep}`)) return false;
  return /-async-response-(submitted|working|input-required)\.json$/.test(path.basename(filePath));
}

test('core async-response-refs let async-response-data compile when original async response schemas are skipped', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-async-response-refs-'));
  try {
    writeJson(path.join(tmpRoot, 'core', 'async-response-data.json'), {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/latest/core/async-response-data.json',
      title: 'Async Response Data',
      description: 'Test async response union.',
      anyOf: [
        { $ref: '/schemas/latest/media-buy/example-response.json' },
        { $ref: '/schemas/latest/media-buy/example-async-response-working.json' },
      ],
    });

    writeJson(path.join(tmpRoot, 'media-buy', 'example-response.json'), {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/latest/media-buy/example-response.json',
      title: 'Example Response',
      description: 'Completed response.',
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    });

    writeJson(path.join(tmpRoot, 'media-buy', 'example-async-response-working.json'), {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/latest/media-buy/example-async-response-working.json',
      title: 'Example Async Working',
      description: 'Working response.',
      type: 'object',
      properties: { percentage: { type: 'number' } },
    });

    const copied = copyAsyncResponseRefsToCore(tmpRoot);
    assert.equal(copied, 1);
    assert.ok(fs.existsSync(path.join(tmpRoot, 'core', 'async-response-refs', 'media-buy', 'example-async-response-working.json')));

    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, validateFormats: false });
    const target = path.join(tmpRoot, 'core', 'async-response-data.json');

    for (const filePath of findJsonFiles(tmpRoot)) {
      if (filePath === target) continue;
      if (isOriginalAsyncResponse(tmpRoot, filePath)) continue;
      const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      ajv.addSchema(schema, schema.$id);
    }

    assert.doesNotThrow(() => {
      ajv.compile(JSON.parse(fs.readFileSync(target, 'utf8')));
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
