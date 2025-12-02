#!/usr/bin/env node
/**
 * A2A Schema Validation Test Suite
 * Validates that all A2A-compatible schemas have proper version tracking metadata
 * and maintain consistency with A2A Protocol specification
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

// A2A schema files that should have version tracking metadata
const A2A_SCHEMAS = [
  'core/a2a-task.json',
  'core/a2a-message.json',
  'core/a2a-task-status-update-event.json',
  'core/a2a-task-artifact-update-event.json',
  'core/a2a-task-status.json',
  'core/a2a-part.json',
  'core/a2a-artifact.json',
  'enums/a2a-role.json'
];

// Expected A2A spec sections for each schema
const A2A_SPEC_SECTIONS = {
  'core/a2a-task.json': '4.1.1',
  'core/a2a-message.json': '4.1.4',
  'core/a2a-task-status-update-event.json': '4.2.1',
  'core/a2a-task-artifact-update-event.json': '4.2.2',
  'core/a2a-task-status.json': '4.1.2',
  'core/a2a-part.json': '4.1.6',
  'core/a2a-artifact.json': '4.1.9',
  'enums/a2a-role.json': '4.1.5'
};

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[0m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m'
  };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

function loadSchema(schemaPath) {
  try {
    const content = fs.readFileSync(schemaPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load schema ${schemaPath}: ${error.message}`);
  }
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'a2a-protocol.org';
  } catch {
    return false;
  }
}

function validateDate(dateString) {
  // Validate ISO 8601 date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) {
    return false;
  }
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

async function test(description, testFn) {
  try {
    const result = await testFn();
    if (result === true || result === undefined) {
      log(`✅ ${description}`, 'success');
      return true;
    } else {
      log(`❌ ${description}: ${result}`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ ${description}: ${error.message}`, 'error');
    return false;
  }
}

async function runTests() {
  log('🧪 Starting A2A Schema Validation Tests', 'info');
  log('==========================================');

  let allPassed = true;

  // Test 1: All A2A schemas exist
  const existsResult = await test('All A2A schema files exist', () => {
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      if (!fs.existsSync(fullPath)) {
        return `Missing schema: ${schemaPath}`;
      }
    }
    return true;
  });
  allPassed = allPassed && existsResult;

  // Test 2: All A2A schemas have required version tracking metadata
  const metadataResult = await test('All A2A schemas have required version tracking metadata', () => {
    const requiredFields = ['a2a_spec_version', 'a2a_spec_section', 'a2a_spec_url', 'adcp_synced_date', 'notes'];
    
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      const schema = loadSchema(fullPath);
      
      for (const field of requiredFields) {
        if (!(field in schema)) {
          return `${schemaPath}: Missing required field '${field}'`;
        }
      }
    }
    return true;
  });
  allPassed = allPassed && metadataResult;

  // Test 3: A2A spec sections match expected values
  const sectionResult = await test('A2A spec sections match expected values', () => {
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      const schema = loadSchema(fullPath);
      const expectedSection = A2A_SPEC_SECTIONS[schemaPath];
      
      if (schema.a2a_spec_section !== expectedSection) {
        return `${schemaPath}: Expected section ${expectedSection}, got ${schema.a2a_spec_section}`;
      }
    }
    return true;
  });
  allPassed = allPassed && sectionResult;

  // Test 4: A2A spec URLs are valid and point to correct sections
  const urlResult = await test('A2A spec URLs are valid and correctly formatted', () => {
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      const schema = loadSchema(fullPath);
      
      if (!validateUrl(schema.a2a_spec_url)) {
        return `${schemaPath}: Invalid A2A spec URL: ${schema.a2a_spec_url}`;
      }
      
      // Check that URL contains the section number
      const expectedSection = A2A_SPEC_SECTIONS[schemaPath];
      const sectionInUrl = expectedSection.replace(/\./g, '');
      if (!schema.a2a_spec_url.includes(sectionInUrl)) {
        return `${schemaPath}: URL ${schema.a2a_spec_url} doesn't match section ${expectedSection}`;
      }
    }
    return true;
  });
  allPassed = allPassed && urlResult;

  // Test 5: A2A spec version is consistent across all schemas
  const versionResult = await test('A2A spec version is consistent across all schemas', () => {
    const versions = new Set();
    
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      const schema = loadSchema(fullPath);
      versions.add(schema.a2a_spec_version);
    }
    
    if (versions.size > 1) {
      return `Inconsistent A2A spec versions found: ${Array.from(versions).join(', ')}`;
    }
    
    if (versions.size === 0 || !versions.has('1.0')) {
      return `Expected A2A spec version 1.0, found: ${Array.from(versions).join(', ')}`;
    }
    
    return true;
  });
  allPassed = allPassed && versionResult;

  // Test 6: ADCP synced date is valid ISO 8601 date
  const dateResult = await test('ADCP synced dates are valid ISO 8601 dates', () => {
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      const schema = loadSchema(fullPath);
      
      if (!validateDate(schema.adcp_synced_date)) {
        return `${schemaPath}: Invalid date format '${schema.adcp_synced_date}' (expected YYYY-MM-DD)`;
      }
    }
    return true;
  });
  allPassed = allPassed && dateResult;

  // Test 7: All A2A schemas have notes explaining they are copies
  const notesResult = await test('All A2A schemas have notes explaining they are A2A copies', () => {
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      const schema = loadSchema(fullPath);
      
      if (!schema.notes || typeof schema.notes !== 'string') {
        return `${schemaPath}: Missing or invalid notes field`;
      }
      
      if (!schema.notes.toLowerCase().includes('a2a') || !schema.notes.toLowerCase().includes('copy')) {
        return `${schemaPath}: Notes should mention A2A and that this is a copy`;
      }
    }
    return true;
  });
  allPassed = allPassed && notesResult;

  // Test 8: A2A schemas reference other A2A schemas correctly
  const refsResult = await test('A2A schemas reference other A2A schemas correctly', () => {
    for (const schemaPath of A2A_SCHEMAS) {
      const fullPath = path.join(SCHEMA_BASE_DIR, schemaPath);
      const schema = loadSchema(fullPath);
      
      // Find all $ref occurrences
      const schemaStr = JSON.stringify(schema);
      const refs = schemaStr.match(/"\$ref":\s*"([^"]+)"/g) || [];
      
      for (const refMatch of refs) {
        const ref = refMatch.match(/"\$ref":\s*"([^"]+)"/)[1];
        
        // If referencing another A2A schema, check it exists
        if (ref.includes('a2a-')) {
          const refPath = ref.replace('/schemas/', '');
          const refFullPath = path.join(SCHEMA_BASE_DIR, refPath);
          
          if (!fs.existsSync(refFullPath)) {
            return `${schemaPath}: References missing A2A schema: ${ref}`;
          }
        }
      }
    }
    return true;
  });
  allPassed = allPassed && refsResult;

  log('\n==========================================');
  if (allPassed) {
    log('🎉 All A2A schema validation tests passed!', 'success');
    return 0;
  } else {
    log('❌ Some A2A schema validation tests failed', 'error');
    return 1;
  }
}

// Run the tests
runTests()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    log(`Test execution failed: ${error.message}`, 'error');
    process.exit(1);
  });

