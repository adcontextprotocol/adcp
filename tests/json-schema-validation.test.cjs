#!/usr/bin/env node
/**
 * JSON Schema Validation Test Suite
 *
 * This test validates JSON examples in documentation against their declared schemas.
 * JSON blocks that include a "$schema" field are validated against that schema.
 *
 * Usage:
 * - npm run test:json-schema                    # Test all files
 * - npm run test:json-schema -- --file path     # Test specific file
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

// Configuration
const DOCS_BASE_DIR = path.join(__dirname, '../docs');
const SCHEMAS_DIR = path.join(__dirname, '../static/schemas/source');

// Test statistics
let totalBlocks = 0;
let validatedBlocks = 0;
let passedBlocks = 0;
let failedBlocks = 0;
let skippedBlocks = 0;
let placeholderBlocks = 0;
let invalidBlocks = 0;

// Parse command line arguments
const args = process.argv.slice(2);
const specificFile = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const verbose = args.includes('--verbose') || args.includes('-v');

// Logging utilities
function log(message, type = 'info') {
  const colors = {
    info: '\x1b[0m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m',
    dim: '\x1b[2m'
  };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

/**
 * Load and resolve a schema with all its $refs
 */
function createAjvInstance() {
  const ajv = new Ajv({
    allErrors: true,
    verbose: true,
    strict: false,
    loadSchema: async (uri) => {
      // Convert URI to local path
      const localPath = uriToLocalPath(uri);
      if (localPath && fs.existsSync(localPath)) {
        return JSON.parse(fs.readFileSync(localPath, 'utf8'));
      }
      throw new Error(`Cannot resolve schema: ${uri}`);
    }
  });
  addFormats(ajv);
  return ajv;
}

/**
 * Convert a schema URI to a local file path
 */
function uriToLocalPath(uri) {
  // Handle various URI formats:
  // - https://adcontextprotocol.org/schemas/latest/adagents.json -> static/schemas/source/adagents.json
  // - /schemas/latest/core/property.json -> static/schemas/source/core/property.json
  // - /schemas/core/property.json -> static/schemas/source/core/property.json

  let schemaPath = uri;

  // Remove URL prefix if present
  schemaPath = schemaPath.replace(/^https?:\/\/[^/]+/, '');

  // Remove /schemas/latest/, /schemas/v{n}/, or /schemas/ prefix
  schemaPath = schemaPath.replace(/^\/schemas\/latest\//, '/');
  schemaPath = schemaPath.replace(/^\/schemas\/v\d+(\.\d+)*\//, '/');
  schemaPath = schemaPath.replace(/^\/schemas\//, '/');

  // Build local path
  return path.join(SCHEMAS_DIR, schemaPath);
}

/**
 * Load all schemas from the source directory into AJV
 */
async function loadAllSchemas(ajv) {
  const schemasLoaded = new Set();

  async function loadSchemaFile(filePath) {
    if (schemasLoaded.has(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const schema = JSON.parse(content);

      // Add schema by its $id if it has one
      if (schema.$id) {
        // Also add with version-prefixed ID
        const versionedId = schema.$id.replace(/^\/schemas\//, '/schemas/v2/');
        try {
          ajv.addSchema(schema, schema.$id);
          ajv.addSchema(schema, versionedId);
          // Also add the https:// version
          ajv.addSchema(schema, `https://adcontextprotocol.org${schema.$id}`);
          ajv.addSchema(schema, `https://adcontextprotocol.org${versionedId}`);
        } catch (e) {
          // Schema already added, ignore
        }
      }

      schemasLoaded.add(filePath);
    } catch (error) {
      log(`Warning: Failed to load schema ${filePath}: ${error.message}`, 'warning');
    }
  }

  // Recursively load all .json files
  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.json')) {
        loadSchemaFile(fullPath);
      }
    }
  }

  walkDir(SCHEMAS_DIR);
  return schemasLoaded.size;
}

/**
 * Extract JSON blocks from markdown/mdx files
 */
function extractJsonBlocks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = [];

  // Regex to match json code blocks
  const codeBlockRegex = /```json[^\n]*\n([\s\S]*?)```/g;

  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const jsonContent = match[1].trim();
    const lineNumber = content.substring(0, match.index).split('\n').length;

    // Skip JSON blocks with placeholder patterns like [...] or {...}
    // These are meant to be illustrative, not complete
    if (/\[\.\.\.\]|\{\.\.\.\}|\.\.\./.test(jsonContent)) {
      blocks.push({
        file: filePath,
        line: lineNumber,
        content: jsonContent,
        parsed: null,
        hasSchema: false,
        isPlaceholder: true
      });
      continue;
    }

    try {
      const parsed = JSON.parse(jsonContent);
      blocks.push({
        file: filePath,
        line: lineNumber,
        content: jsonContent,
        parsed,
        hasSchema: !!parsed.$schema
      });
    } catch (e) {
      // Invalid JSON - skip but note it
      if (verbose) {
        log(`  Warning: Invalid JSON at ${path.relative(DOCS_BASE_DIR, filePath)}:${lineNumber}: ${e.message}`, 'warning');
      }
      blocks.push({
        file: filePath,
        line: lineNumber,
        content: jsonContent,
        parsed: null,
        hasSchema: false,
        isInvalid: true,
        error: e.message
      });
    }
  }

  return blocks;
}

/**
 * Find all documentation files
 */
function findDocFiles() {
  const files = [];

  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
        files.push(fullPath);
      }
    }
  }

  walkDir(DOCS_BASE_DIR);
  return files;
}

/**
 * Validate a JSON block against its declared schema
 */
async function validateJsonBlock(ajv, block) {
  if (!block.hasSchema) {
    skippedBlocks++;
    return { status: 'skipped', reason: 'No $schema field' };
  }

  validatedBlocks++;

  const schemaUri = block.parsed.$schema;
  let validate;

  try {
    validate = ajv.getSchema(schemaUri);
    if (!validate) {
      // Try without the version prefix (latest/ or v{n}/)
      let simplifiedUri = schemaUri.replace(/\/latest\//, '/');
      simplifiedUri = simplifiedUri.replace(/\/v\d+(\.\d+)*\//, '/');
      validate = ajv.getSchema(simplifiedUri);
    }
  } catch (e) {
    failedBlocks++;
    return {
      status: 'error',
      reason: `Schema not found: ${schemaUri}`
    };
  }

  if (!validate) {
    failedBlocks++;
    return {
      status: 'error',
      reason: `Schema not found: ${schemaUri}`
    };
  }

  // Strip $schema from the data before validating
  // (the $schema field itself isn't part of the data schema)
  const dataToValidate = { ...block.parsed };
  delete dataToValidate.$schema;

  const valid = validate(dataToValidate);

  if (valid) {
    passedBlocks++;
    return { status: 'passed' };
  } else {
    failedBlocks++;
    return {
      status: 'failed',
      errors: validate.errors
    };
  }
}

/**
 * Format validation errors for display
 */
function formatErrors(errors) {
  if (!errors || errors.length === 0) return '';

  return errors.map(err => {
    const path = err.instancePath || '(root)';
    return `    - ${path}: ${err.message}`;
  }).join('\n');
}

/**
 * Main test runner
 */
async function runTests() {
  log('==========================================', 'info');
  log('JSON Schema Validation for Documentation', 'info');
  log('==========================================\n', 'info');

  // Create AJV instance and load schemas
  const ajv = createAjvInstance();
  log('Loading schemas from: ' + SCHEMAS_DIR, 'dim');
  const schemaCount = await loadAllSchemas(ajv);
  log(`Loaded ${schemaCount} schema files\n`, 'dim');

  // Find doc files
  let docFiles = findDocFiles();

  if (specificFile) {
    const absolutePath = path.isAbsolute(specificFile)
      ? specificFile
      : path.join(process.cwd(), specificFile);
    docFiles = docFiles.filter(f => f === absolutePath || f.endsWith(specificFile));
    if (docFiles.length === 0) {
      log(`Error: File not found: ${specificFile}`, 'error');
      process.exit(1);
    }
    log(`Testing specific file: ${specificFile}\n`, 'info');
  }

  log(`Found ${docFiles.length} documentation files\n`, 'info');

  // Process each file
  const fileResults = {};

  for (const file of docFiles) {
    const relativePath = path.relative(DOCS_BASE_DIR, file);
    const blocks = extractJsonBlocks(file);

    if (blocks.length === 0) continue;

    // Count block types
    totalBlocks += blocks.length;
    const blocksWithSchema = blocks.filter(b => b.hasSchema);
    const blocksPlaceholder = blocks.filter(b => b.isPlaceholder);
    const blocksInvalid = blocks.filter(b => b.isInvalid);
    const blocksValid = blocks.filter(b => b.parsed && !b.hasSchema);

    placeholderBlocks += blocksPlaceholder.length;
    invalidBlocks += blocksInvalid.length;

    if (blocksWithSchema.length === 0) {
      if (verbose) {
        const details = [];
        if (blocksValid.length > 0) details.push(`${blocksValid.length} valid`);
        if (blocksPlaceholder.length > 0) details.push(`${blocksPlaceholder.length} placeholder`);
        if (blocksInvalid.length > 0) details.push(`${blocksInvalid.length} invalid`);
        log(`${relativePath}: ${blocks.length} JSON blocks (${details.join(', ')}) - none with $schema`, 'dim');
      }
      continue;
    }

    log(`\n${relativePath}: ${blocksWithSchema.length} JSON blocks with $schema`, 'info');

    let filePassed = true;

    for (const block of blocksWithSchema) {
      const result = await validateJsonBlock(ajv, block);

      if (result.status === 'passed') {
        log(`  ✓ Line ${block.line}: Valid`, 'success');
      } else if (result.status === 'failed') {
        filePassed = false;
        log(`  ✗ Line ${block.line}: Invalid`, 'error');
        log(`    Schema: ${block.parsed.$schema}`, 'error');
        log(formatErrors(result.errors), 'error');
      } else if (result.status === 'error') {
        filePassed = false;
        log(`  ⚠ Line ${block.line}: ${result.reason}`, 'warning');
      }
    }

    fileResults[relativePath] = filePassed;
  }

  // Print summary
  log('\n==========================================', 'info');
  log('Summary', 'info');
  log('==========================================', 'info');
  log(`Total JSON blocks found: ${totalBlocks}`, 'info');
  log(`  - With $schema: ${validatedBlocks}`, 'info');
  log(`  - Valid JSON (no schema): ${totalBlocks - validatedBlocks - placeholderBlocks - invalidBlocks}`, 'dim');
  log(`  - Placeholder (...): ${placeholderBlocks}`, 'dim');
  log(`  - Invalid JSON: ${invalidBlocks}`, invalidBlocks > 0 ? 'warning' : 'dim');
  log('', 'info');
  log(`Validation results:`, 'info');
  log(`  Passed: ${passedBlocks}`, 'success');
  log(`  Failed: ${failedBlocks}`, failedBlocks > 0 ? 'error' : 'info');

  // Exit with error code if any validations failed
  if (failedBlocks > 0) {
    log('\n❌ Some JSON blocks failed validation', 'error');
    process.exit(1);
  } else if (validatedBlocks === 0) {
    log('\n⚠️  No JSON blocks with $schema found', 'warning');
    process.exit(0);
  } else {
    log('\n✅ All JSON blocks with $schema validated successfully!', 'success');
    process.exit(0);
  }
}

// Run tests
runTests().catch(error => {
  log(`\nFatal error: ${error.message}`, 'error');
  console.error(error);
  process.exit(1);
});
