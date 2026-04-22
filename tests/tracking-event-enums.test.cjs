#!/usr/bin/env node
/**
 * Tracking event enum validation tests
 * Validates VAST and DAAST tracking event enums against asset schemas
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

// Schema loader for resolving $ref
async function loadExternalSchema(uri) {
  let relativePath;
  if (uri.startsWith('/schemas/latest/')) {
    relativePath = uri.replace('/schemas/latest/', '');
  } else if (uri.startsWith('/schemas/')) {
    relativePath = uri.replace('/schemas/', '');
  } else {
    throw new Error(`Cannot load external schema: ${uri}`);
  }

  const schemaPath = path.join(SCHEMA_BASE_DIR, relativePath);
  try {
    const content = fs.readFileSync(schemaPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load referenced schema ${uri}: ${error.message}`);
  }
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[0m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m'
  };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

async function test(description, testFn) {
  totalTests++;
  try {
    const result = await testFn();
    if (result === true || result === undefined) {
      log(`✅ ${description}`, 'success');
      passedTests++;
    } else {
      log(`❌ ${description}: ${result}`, 'error');
      failedTests++;
    }
  } catch (error) {
    log(`❌ ${description}: ${error.message}`, 'error');
    failedTests++;
  }
}

function loadSchema(schemaPath) {
  const content = fs.readFileSync(schemaPath, 'utf8');
  return JSON.parse(content);
}

async function compileSchema(schemaPath) {
  const ajv = new Ajv({
    allErrors: true,
    verbose: true,
    strict: false,
    loadSchema: loadExternalSchema
  });
  addFormats(ajv);
  const schema = loadSchema(schemaPath);
  return ajv.compileAsync(schema);
}

// VAST 4.2 tracking events (includes flattened Impression, Error, VideoClicks, ViewableImpression)
const VAST_PLAYBACK_EVENTS = ['impression', 'creativeView', 'loaded', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete'];
const VAST_INTERACTION_EVENTS = ['mute', 'unmute', 'pause', 'resume', 'rewind', 'skip', 'playerExpand', 'playerCollapse', 'fullscreen', 'exitFullscreen', 'otherAdInteraction', 'interactiveStart'];
const VAST_PROGRESS_EVENTS = ['progress', 'notUsed'];
const VAST_CLICK_CLOSE_EVENTS = ['clickTracking', 'customClick', 'close', 'closeLinear'];
const VAST_VERIFICATION_EVENTS = ['error', 'viewable', 'notViewable', 'viewUndetermined', 'measurableImpression', 'viewableImpression'];

const ALL_VAST_EVENTS = [
  ...VAST_PLAYBACK_EVENTS,
  ...VAST_INTERACTION_EVENTS,
  ...VAST_PROGRESS_EVENTS,
  ...VAST_CLICK_CLOSE_EVENTS,
  ...VAST_VERIFICATION_EVENTS
];

// DAAST tracking events (audio-appropriate subset)
const ALL_DAAST_EVENTS = [
  'impression', 'creativeView', 'loaded', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete',
  'mute', 'unmute', 'pause', 'resume', 'skip',
  'progress',
  'clickTracking', 'customClick', 'close',
  'error', 'viewable', 'notViewable', 'viewUndetermined', 'measurableImpression', 'viewableImpression'
];

async function runTests() {
  log('\n=== VAST/DAAST Tracking Event Enum Validation ===\n');

  // Load enum schemas directly
  const vastEnumSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'enums/vast-tracking-event.json'));
  const daastEnumSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'enums/daast-tracking-event.json'));

  // --- VAST enum tests ---
  log('\n--- VAST Tracking Event Enum ---\n');

  await test('VAST enum contains all expected events', () => {
    const enumValues = vastEnumSchema.enum;
    for (const event of ALL_VAST_EVENTS) {
      if (!enumValues.includes(event)) {
        return `Missing event: ${event}`;
      }
    }
  });

  await test('VAST enum has no unexpected events', () => {
    const enumValues = vastEnumSchema.enum;
    for (const event of enumValues) {
      if (!ALL_VAST_EVENTS.includes(event)) {
        return `Unexpected event: ${event}`;
      }
    }
  });

  await test('VAST enum values are camelCase strings', () => {
    for (const event of vastEnumSchema.enum) {
      if (typeof event !== 'string') return `Non-string value: ${event}`;
      if (event.includes('_') || event.includes('-') || event.includes(' ')) {
        return `Non-camelCase value: ${event}`;
      }
    }
  });

  // --- DAAST enum tests ---
  log('\n--- DAAST Tracking Event Enum ---\n');

  await test('DAAST enum contains all expected events', () => {
    const enumValues = daastEnumSchema.enum;
    for (const event of ALL_DAAST_EVENTS) {
      if (!enumValues.includes(event)) {
        return `Missing event: ${event}`;
      }
    }
  });

  await test('DAAST enum has no unexpected events', () => {
    const enumValues = daastEnumSchema.enum;
    for (const event of enumValues) {
      if (!ALL_DAAST_EVENTS.includes(event)) {
        return `Unexpected event: ${event}`;
      }
    }
  });

  await test('DAAST events are a subset of VAST events', () => {
    for (const event of daastEnumSchema.enum) {
      if (!vastEnumSchema.enum.includes(event)) {
        return `DAAST event "${event}" not in VAST enum`;
      }
    }
  });

  // --- VAST asset schema validation ---
  log('\n--- VAST Asset Schema Validation ---\n');

  const vastAssetValidate = await compileSchema(
    path.join(SCHEMA_BASE_DIR, 'core/assets/vast-asset.json')
  );

  await test('VAST asset with all tracking events validates', () => {
    const valid = vastAssetValidate({
      asset_type: 'vast',
      delivery_type: 'url',
      url: 'https://vast.example.com/video/123',
      tracking_events: ALL_VAST_EVENTS
    });
    if (!valid) return JSON.stringify(vastAssetValidate.errors);
  });

  await test('VAST asset with single tracking event validates', () => {
    const valid = vastAssetValidate({
      asset_type: 'vast',
      delivery_type: 'url',
      url: 'https://vast.example.com/video/123',
      tracking_events: ['impression']
    });
    if (!valid) return JSON.stringify(vastAssetValidate.errors);
  });

  await test('VAST asset with invalid tracking event rejects', () => {
    const valid = vastAssetValidate({
      asset_type: 'vast',
      delivery_type: 'url',
      url: 'https://vast.example.com/video/123',
      tracking_events: ['nonExistentEvent']
    });
    if (valid) return 'Expected validation to fail for invalid event name';
  });

  await test('VAST asset rejects removed "click" event (use clickTracking)', () => {
    const valid = vastAssetValidate({
      asset_type: 'vast',
      delivery_type: 'url',
      url: 'https://vast.example.com/video/123',
      tracking_events: ['click']
    });
    if (valid) return 'Expected "click" to be rejected — use "clickTracking" instead';
  });

  // --- DAAST asset schema validation ---
  log('\n--- DAAST Asset Schema Validation ---\n');

  const daastAssetValidate = await compileSchema(
    path.join(SCHEMA_BASE_DIR, 'core/assets/daast-asset.json')
  );

  await test('DAAST asset with all tracking events validates', () => {
    const valid = daastAssetValidate({
      asset_type: 'daast',
      delivery_type: 'url',
      url: 'https://daast.example.com/audio/456',
      tracking_events: ALL_DAAST_EVENTS
    });
    if (!valid) return JSON.stringify(daastAssetValidate.errors);
  });

  await test('DAAST asset with invalid tracking event rejects', () => {
    const valid = daastAssetValidate({
      asset_type: 'daast',
      delivery_type: 'url',
      url: 'https://daast.example.com/audio/456',
      tracking_events: ['closeLinear']
    });
    if (valid) return 'Expected validation to fail for video-only event in DAAST';
  });

  // --- Summary ---
  log(`\n=== Results: ${passedTests}/${totalTests} passed ===\n`,
    failedTests > 0 ? 'error' : 'success');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
