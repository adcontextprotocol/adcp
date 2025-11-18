#!/usr/bin/env node
/**
 * Script to add ext field to all request and response schemas
 */

const fs = require('fs');
const path = require('path');

const REQUEST_EXT_DESCRIPTION = "Extension object for request-scoped implementation-specific parameters. Unlike 'context' which is echoed unchanged, extensions MAY affect task behavior. Implementers SHOULD namespace custom fields (e.g., 'buyer_*', 'test_*', 'trace_*'). See https://docs.adcontextprotocol.org/reference/extensions for conventions and examples.";

const RESPONSE_EXT_DESCRIPTION = "Extension object for response-scoped implementation-specific metadata. Use for processing diagnostics, debug information, or operation-specific hints. Separate from domain object extensions which represent persistent state. See https://docs.adcontextprotocol.org/reference/extensions for conventions and examples.";

function addExtToSchema(filePath, isRequest) {
  const content = fs.readFileSync(filePath, 'utf8');
  const schema = JSON.parse(content);

  // Check if ext already exists
  if (schema.properties && schema.properties.ext) {
    console.log(`⏭️  Skipping ${path.basename(filePath)} - ext already exists`);
    return false;
  }

  // Add ext property
  if (!schema.properties) {
    schema.properties = {};
  }

  schema.properties.ext = {
    type: 'object',
    description: isRequest ? REQUEST_EXT_DESCRIPTION : RESPONSE_EXT_DESCRIPTION,
    additionalProperties: true
  };

  // Write back
  fs.writeFileSync(filePath, JSON.stringify(schema, null, 2) + '\n');
  console.log(`✅ Updated ${path.basename(filePath)}`);
  return true;
}

function findSchemas(dir, pattern) {
  const schemas = [];

  function traverse(currentDir) {
    const items = fs.readdirSync(currentDir);

    for (const item of items) {
      const itemPath = path.join(currentDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        traverse(itemPath);
      } else if (item.endsWith(pattern)) {
        schemas.push(itemPath);
      }
    }
  }

  traverse(dir);
  return schemas;
}

const SCHEMA_DIR = path.join(__dirname, '../static/schemas/v1');

console.log('🔍 Finding request and response schemas...\n');

const requestSchemas = findSchemas(SCHEMA_DIR, '-request.json');
const responseSchemas = findSchemas(SCHEMA_DIR, '-response.json');

console.log(`Found ${requestSchemas.length} request schemas`);
console.log(`Found ${responseSchemas.length} response schemas\n`);

console.log('📝 Adding ext to request schemas...');
let requestUpdated = 0;
for (const schemaPath of requestSchemas) {
  if (addExtToSchema(schemaPath, true)) {
    requestUpdated++;
  }
}

console.log(`\n📝 Adding ext to response schemas...`);
let responseUpdated = 0;
for (const schemaPath of responseSchemas) {
  if (addExtToSchema(schemaPath, false)) {
    responseUpdated++;
  }
}

console.log(`\n✨ Complete!`);
console.log(`   Updated ${requestUpdated} request schemas`);
console.log(`   Updated ${responseUpdated} response schemas`);
