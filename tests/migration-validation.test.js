#!/usr/bin/env node
/**
 * Migration validation test suite
 * Validates that migration files have unique version numbers and proper naming
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../server/src/db/migrations');

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

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    log(`  ✓ ${name}`, 'success');
  } catch (error) {
    failedTests++;
    log(`  ✗ ${name}`, 'error');
    log(`    ${error.message}`, 'error');
  }
}

function getMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  return files.filter(f => f.endsWith('.sql'));
}

function parseMigrationFilename(filename) {
  const match = filename.match(/^(\d+)_(.+)\.sql$/);
  if (!match) return null;
  return {
    version: parseInt(match[1], 10),
    description: match[2],
    filename
  };
}

function runTests() {
  log('\n📋 Migration Validation Tests\n');

  const files = getMigrationFiles();
  const migrations = files
    .map(parseMigrationFilename)
    .filter(m => m !== null);

  // Test 1: All migration files have valid naming
  log('Testing migration file naming...', 'info');
  test('All files match NNN_description.sql pattern', () => {
    const invalidFiles = files.filter(f => !parseMigrationFilename(f));
    if (invalidFiles.length > 0) {
      throw new Error(`Invalid migration filenames: ${invalidFiles.join(', ')}`);
    }
  });

  // Test 2: No duplicate version numbers
  log('Testing for duplicate version numbers...', 'info');
  test('No duplicate migration version numbers', () => {
    const versionMap = new Map();
    const duplicates = [];

    for (const migration of migrations) {
      if (versionMap.has(migration.version)) {
        duplicates.push({
          version: migration.version,
          files: [versionMap.get(migration.version), migration.filename]
        });
      } else {
        versionMap.set(migration.version, migration.filename);
      }
    }

    if (duplicates.length > 0) {
      const details = duplicates
        .map(d => `  Version ${d.version}: ${d.files.join(' AND ')}`)
        .join('\n');
      throw new Error(`Duplicate migration versions found:\n${details}`);
    }
  });

  // Test 3: Version numbers are positive integers
  log('Testing version number validity...', 'info');
  test('All version numbers are positive integers', () => {
    const invalid = migrations.filter(m => m.version <= 0 || !Number.isInteger(m.version));
    if (invalid.length > 0) {
      throw new Error(`Invalid version numbers: ${invalid.map(m => m.filename).join(', ')}`);
    }
  });

  // Test 4: No gaps larger than 10 (warning, not failure)
  log('Checking for version number gaps...', 'info');
  const versions = migrations.map(m => m.version).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < versions.length; i++) {
    const gap = versions[i] - versions[i - 1];
    if (gap > 10) {
      gaps.push({ from: versions[i - 1], to: versions[i], gap });
    }
  }
  if (gaps.length > 0) {
    log(`  ⚠ Large version gaps detected (not an error):`, 'warning');
    gaps.forEach(g => {
      log(`    Gap of ${g.gap} between ${g.from} and ${g.to}`, 'warning');
    });
  }

  // Summary
  log('\n' + '='.repeat(50), 'info');
  log(`Total: ${totalTests} tests`, 'info');
  log(`Passed: ${passedTests}`, 'success');
  if (failedTests > 0) {
    log(`Failed: ${failedTests}`, 'error');
  }

  return failedTests === 0;
}

// Run tests
const success = runTests();
process.exit(success ? 0 : 1);
