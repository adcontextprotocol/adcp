# AdCP JSON Schemas

This directory contains JSON Schema definitions for all AdCP (Advertising Context Protocol) objects and task request/response structures.

## Overview

The schemas are organized to provide comprehensive validation for:
- **Core Data Models**: Fundamental objects used throughout the protocol
- **Task Schemas**: Request and response structures for each protocol task
- **Enums**: Standardized enumerated values
- **Signal Protocol**: Schemas specific to the signals extension

## Directory Structure

```
schemas/
├── v1/                           # Version 1 schemas
│   ├── core/                     # Core data models
│   │   ├── product.json
│   │   ├── media-buy.json
│   │   ├── package.json
│   │   ├── creative-asset.json
│   │   ├── targeting.json
│   │   ├── budget.json
│   │   ├── frequency-cap.json
│   │   ├── format.json
│   │   ├── measurement.json
│   │   ├── creative-policy.json
│   │   ├── error.json
│   │   └── response.json
│   ├── media-buy/               # Media buy task schemas
│   │   ├── get-products-request.json
│   │   ├── get-products-response.json
│   │   ├── create-media-buy-request.json
│   │   ├── create-media-buy-response.json
│   │   ├── add-creative-assets-request.json
│   │   ├── add-creative-assets-response.json
│   │   ├── update-media-buy-request.json
│   │   ├── update-media-buy-response.json
│   │   ├── get-media-buy-delivery-request.json
│   │   ├── get-media-buy-delivery-response.json
│   │   ├── list-creative-formats-request.json
│   │   └── list-creative-formats-response.json
│   ├── signals/                 # Signals protocol schemas
│   │   ├── get-signals-request.json
│   │   ├── get-signals-response.json
│   │   ├── activate-signal-request.json
│   │   └── activate-signal-response.json
│   ├── enums/                   # Enum definitions
│   │   ├── delivery-type.json
│   │   ├── media-buy-status.json
│   │   ├── creative-status.json
│   │   ├── package-status.json
│   │   ├── pacing.json
│   │   └── frequency-cap-scope.json
│   └── index.json              # Schema registry
├── asset-types-v1.json         # Creative asset types (existing)
├── creative-formats-v1.json    # Creative format definitions (existing)
└── README.md                   # This file
```

## Usage

### Local Development

When running the Docusaurus development server locally (`npm run start`), all schemas are accessible at:
- **Schema Registry**: `http://localhost:3000/schemas/v1/index.json`
- **Core Schemas**: `http://localhost:3000/schemas/v1/core/{schema-name}.json`
- **Task Schemas**: `http://localhost:3000/schemas/v1/media-buy/{task-name}-{request|response}.json`
- **Signals Schemas**: `http://localhost:3000/schemas/v1/signals/{task-name}-{request|response}.json`
- **Enum Schemas**: `http://localhost:3000/schemas/v1/enums/{enum-name}.json`

### Schema Registry

The `v1/index.json` file serves as the main registry for all schemas, providing:
- Schema URLs and references
- Descriptions for each schema
- Usage examples
- Categorization by protocol area

### Validation Examples

#### JavaScript (Node.js)

```javascript
const Ajv = require('ajv');
const ajv = new Ajv();

// Load and validate a product
const productSchema = require('./schemas/v1/core/product.json');
const validateProduct = ajv.compile(productSchema);

const product = {
  "product_id": "ctv_sports_premium",
  "name": "CTV Sports Premium",
  "description": "Premium CTV inventory on sports content",
  "formats": [{"format_id": "video_16x9_30s", "name": "30-second video"}],
  "delivery_type": "guaranteed",
  "is_fixed_price": true
};

const isValid = validateProduct(product);
if (!isValid) {
  console.log(validateProduct.errors);
}
```

#### Python

```python
import jsonschema
import json

# Load schema
with open('schemas/v1/core/product.json') as f:
    schema = json.load(f)

# Validate data
product = {
    "product_id": "ctv_sports_premium",
    "name": "CTV Sports Premium",
    "description": "Premium CTV inventory on sports content",
    "formats": [{"format_id": "video_16x9_30s", "name": "30-second video"}],
    "delivery_type": "guaranteed",
    "is_fixed_price": True
}

try:
    jsonschema.validate(product, schema)
    print("Valid!")
except jsonschema.ValidationError as e:
    print(f"Validation error: {e.message}")
```

#### Java

```java
import com.github.fge.jsonschema.main.JsonSchema;
import com.github.fge.jsonschema.main.JsonSchemaFactory;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

// Load schema
ObjectMapper mapper = new ObjectMapper();
JsonNode schemaNode = mapper.readTree(new File("schemas/v1/core/product.json"));
JsonSchemaFactory factory = JsonSchemaFactory.byDefault();
JsonSchema schema = factory.getJsonSchema(schemaNode);

// Validate data
JsonNode data = mapper.readTree(jsonString);
ProcessingReport report = schema.validate(data);
```

## Schema Standards

All schemas follow these conventions:

### JSON Schema Draft 07

All schemas use JSON Schema Draft 07 specification.

### Schema IDs

Each schema has a unique `$id` following the pattern:
```
https://adcp.dev/schemas/v1/{category}/{name}.json
```

### Cross-References

Schemas reference each other using `$ref` to maintain consistency and avoid duplication.

### Descriptions

All properties include comprehensive descriptions explaining their purpose and usage.

### Validation Rules

- String patterns for IDs and codes
- Minimum/maximum constraints for numeric values
- Required field specifications
- Additional property restrictions

## Protocol Coverage

### Media Buy Protocol

All media buy tasks are covered with complete request/response schemas:
- `get_products` - Product discovery
- `list_creative_formats` - Format discovery  
- `create_media_buy` - Campaign creation
- `sync_creatives` - Creative upload and management
- `update_media_buy` - Campaign updates
- `get_media_buy_delivery` - Performance reporting

### Signals Protocol

Signal-related tasks have dedicated schemas:
- `get_signals` - Signal discovery
- `activate_signal` - Signal activation

### Core Data Models

All fundamental protocol objects are defined:
- Products, Media Buys, Packages
- Creative Assets and Formats
- Targeting and Budget structures
- Measurement and Policy objects

## Versioning

Schemas are versioned using semantic versioning in the directory structure:
- `v1/` - Version 1.x schemas
- `v2/` - Version 2.x schemas (future)

Major version changes indicate breaking changes to the schema structure.

## Integration

### Client Libraries

Use these schemas to generate strongly-typed client libraries in various languages:
- OpenAPI Generator
- quicktype
- Language-specific code generation tools

### API Documentation

Reference schemas in API documentation to provide:
- Interactive validation
- Type information  
- Field descriptions
- Example data structures

### Testing

Use schemas to validate:
- API test fixtures
- Example data in documentation
- Integration test payloads
- Mock data generation

## Testing

### Automated Testing

The schema implementation includes comprehensive testing to ensure accuracy and consistency:

#### Schema Validation Tests
```bash
# Test all schemas are syntactically valid
npm run test:schemas

# Individual schema validation
node tests/schema-validation.test.js
```

This validates:
- All 36 schemas are syntactically correct JSON Schema Draft-07
- Cross-references (`$ref`) resolve properly
- Schema registry is consistent with actual files
- Required fields and constraints are properly defined

#### Example Data Validation Tests
```bash
# Test example data against schemas
npm run test:examples

# Individual example validation
node tests/example-validation-simple.test.js
```

This validates:
- Example data from documentation matches schemas
- Request/response structures are correctly defined
- Core data models validate properly

#### Complete Test Suite
```bash
# Run all tests including TypeScript checks
npm test
```

### Pre-commit Validation

A pre-commit hook automatically ensures schema integrity on every commit:

```bash
# Pre-commit hook runs automatically, or test manually via:
npm run precommit
```

This runs:
1. Schema validation tests (6 tests)
2. Example data validation tests (7 tests)  
3. TypeScript type checking

### Manual Testing

#### Test Schema Loading Locally
```bash
# Start development server
npm run start

# Visit schema URLs in browser:
# http://localhost:3000/schemas/v1/index.json
# http://localhost:3000/schemas/v1/core/product.json
# etc.
```

#### Test with External Validators
```bash
# Online JSON Schema validators:
# - https://www.jsonschemavalidator.net/
# - https://jsonschemalint.com/

# Load schema from local server when testing
```

### Troubleshooting

Common issues and solutions:

#### Schema Reference Errors
```
Error: can't resolve reference /schemas/v1/enums/pacing.json
```
**Solution**: Ensure all referenced schemas exist and paths are correct.

#### Duplicate Schema IDs
```  
Error: schema with key or id already exists
```
**Solution**: Check for duplicate `$id` values across schemas.

#### Validation Failures
```
Schema validation failed for: {data}
```
**Solution**: Compare data structure against schema requirements, check required fields.

## Contributing

When updating schemas:

1. **Follow existing naming conventions**
2. **Maintain backward compatibility** within major versions
3. **Update the schema registry** (`index.json`)
4. **Run all tests** before committing:
   ```bash
   npm test
   ```
5. **Update documentation** to match schema changes
6. **Add validation examples** for new schemas
7. **Test locally** by starting dev server and accessing schema URLs

### Schema-Documentation Consistency

**CRITICAL**: Documentation and JSON schemas MUST always be synchronized.

When making changes:
- ✅ Update documentation first
- ✅ Update corresponding schemas
- ✅ Run validation tests 
- ✅ Test example data
- ✅ Update schema registry if needed
- ✅ Run pre-commit checks

## Support

For questions about the schemas or validation issues:
- Check the AdCP documentation
- Review the schema registry for available schemas
- Validate your data structure against the appropriate schema