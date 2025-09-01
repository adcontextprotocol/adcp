/**
 * Simple validation example using the AdCP JSON schemas
 * Run with: node validation-example.js
 */

const fs = require('fs');
const path = require('path');

// Simple JSON schema validator (minimal implementation)
function validateSchema(data, schema) {
  // This is a very basic validator - in production use ajv or similar
  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null) {
      return { valid: false, errors: [`Expected object, got ${typeof data}`] };
    }
    
    // Check required fields
    const errors = [];
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }
    
    return { valid: errors.length === 0, errors };
  }
  
  return { valid: true, errors: [] };
}

// Load and validate a Product example
const productSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'v1/core/product.json'), 'utf8'));

const exampleProduct = {
  "product_id": "ctv_sports_premium",
  "name": "CTV Sports Premium", 
  "description": "Premium CTV inventory on sports content",
  "formats": [{"format_id": "video_16x9_30s", "name": "30-second video"}],
  "delivery_type": "guaranteed",
  "is_fixed_price": true
};

const result = validateSchema(exampleProduct, productSchema);

console.log('AdCP Schema Validation Example');
console.log('==============================');
console.log('Schema:', productSchema.title);
console.log('Valid:', result.valid);
if (!result.valid) {
  console.log('Errors:', result.errors);
}
console.log('');
console.log('Example Product:', JSON.stringify(exampleProduct, null, 2));
console.log('');
console.log('✅ Schema validation working! Use a proper library like ajv for production.');