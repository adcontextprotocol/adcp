#!/usr/bin/env node

/**
 * Generate OpenAPI 3.0 specifications for AdCP agent APIs
 *
 * Creates three separate OpenAPI specs:
 * - Sales Agent API (Media Buy Protocol)
 * - Creative Agent API (Creative Protocol)
 * - Signals Agent API (Signals Protocol)
 */

const fs = require('fs');
const path = require('path');

const SCHEMAS_DIR = path.join(__dirname, '../static/schemas/v1');
const OUTPUT_DIR = path.join(__dirname, '../static/openapi');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Read schema registry to get version
const registry = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, 'index.json'), 'utf-8'));
const adcpVersion = registry.adcp_version;

/**
 * Sales Agent API Configuration
 */
const salesAgentTasks = [
  {
    name: 'get_products',
    summary: 'Discover Available Products',
    description: 'Search for advertising products using natural language. Returns products matching the brief with pricing, targeting, and format information.',
    tag: 'Product Discovery'
  },
  {
    name: 'list_authorized_properties',
    summary: 'List Authorized Properties',
    description: 'Retrieve the list of advertising properties (websites, apps, channels) that the agent is authorized to sell.',
    tag: 'Capability Discovery'
  },
  {
    name: 'create_media_buy',
    summary: 'Create Media Buy',
    description: 'Create a new media buy (campaign) with specified products, budget, dates, creatives, and targeting.',
    tag: 'Media Buys'
  },
  {
    name: 'update_media_buy',
    summary: 'Update Media Buy',
    description: 'Update an existing media buy with new budget, dates, status, or other modifications.',
    tag: 'Media Buys'
  },
  {
    name: 'get_media_buy_delivery',
    summary: 'Get Media Buy Delivery',
    description: 'Retrieve delivery metrics and performance data for a media buy.',
    tag: 'Performance & Reporting'
  },
  {
    name: 'sync_creatives',
    summary: 'Sync Creatives',
    description: 'Synchronize creative assets with the sales agent for trafficking to ad servers.',
    tag: 'Creatives'
  },
  {
    name: 'provide_performance_feedback',
    summary: 'Provide Performance Feedback',
    description: 'Submit performance feedback to help optimize media buy delivery.',
    tag: 'Performance & Reporting'
  }
];

/**
 * Creative Agent API Configuration
 */
const creativeAgentTasks = [
  {
    name: 'list_creative_formats',
    summary: 'List Creative Formats',
    description: 'Discover available creative formats with their requirements, dimensions, and asset specifications.',
    tag: 'Format Discovery'
  },
  {
    name: 'build_creative',
    summary: 'Build Creative',
    description: 'Generate creative assets from a natural language brief using AI.',
    tag: 'Generative Creative'
  },
  {
    name: 'preview_creative',
    summary: 'Preview Creative',
    description: 'Generate preview renderings of a creative manifest to see how it will appear.',
    tag: 'Creative Preview'
  },
  {
    name: 'list_creatives',
    summary: 'List Creatives',
    description: 'Retrieve a list of creative manifests stored by the creative agent.',
    tag: 'Creative Management'
  }
];

/**
 * Signals Agent API Configuration
 */
const signalsAgentTasks = [
  {
    name: 'get_signals',
    summary: 'Get Signals',
    description: 'Retrieve audience signals (segments, cohorts, audiences) based on natural language criteria.',
    tag: 'Signal Discovery'
  },
  {
    name: 'activate_signal',
    summary: 'Activate Signal',
    description: 'Activate an audience signal for use in targeting.',
    tag: 'Signal Activation'
  }
];

/**
 * Generate OpenAPI operation from task configuration
 */
function generateOperation(task, schemaDir) {
  const requestSchemaPath = path.join(SCHEMAS_DIR, schemaDir, `${task.name.replace(/_/g, '-')}-request.json`);
  const responseSchemaPath = path.join(SCHEMAS_DIR, schemaDir, `${task.name.replace(/_/g, '-')}-response.json`);

  const operation = {
    summary: task.summary,
    description: task.description,
    operationId: task.name,
    tags: [task.tag],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            $ref: `https://adcontextprotocol.org/schemas/v1/${schemaDir}/${task.name.replace(/_/g, '-')}-request.json`
          }
        }
      }
    },
    responses: {
      '200': {
        description: 'Successful response',
        content: {
          'application/json': {
            schema: {
              $ref: `https://adcontextprotocol.org/schemas/v1/${schemaDir}/${task.name.replace(/_/g, '-')}-response.json`
            }
          }
        }
      },
      '400': {
        description: 'Bad request - invalid parameters',
        content: {
          'application/json': {
            schema: {
              $ref: 'https://adcontextprotocol.org/schemas/v1/core/error.json'
            }
          }
        }
      },
      '500': {
        description: 'Internal server error',
        content: {
          'application/json': {
            schema: {
              $ref: 'https://adcontextprotocol.org/schemas/v1/core/error.json'
            }
          }
        }
      }
    }
  };

  return operation;
}

/**
 * Generate OpenAPI spec for an agent type
 */
function generateOpenAPISpec(agentType, tasks, schemaDir) {
  const agentUrls = {
    sales: 'https://salesagent.adcontextprotocol.org',
    creative: 'https://creative.adcontextprotocol.org',
    signals: 'https://signalsagent.adcontextprotocol.org'
  };

  const agentDescriptions = {
    sales: 'The Sales Agent API implements the Media Buy Protocol, enabling AI agents to discover advertising products, create and manage media buys, sync creatives, and track performance.',
    creative: 'The Creative Agent API implements the Creative Protocol, enabling AI agents to discover creative formats, generate assets, preview creatives, and manage creative manifests.',
    signals: 'The Signals Agent API implements the Signals Protocol, enabling AI agents to discover and activate audience signals for targeting.'
  };

  const agentTitles = {
    sales: 'Sales Agent API',
    creative: 'Creative Agent API',
    signals: 'Signals Agent API'
  };

  const spec = {
    openapi: '3.0.3',
    info: {
      title: agentTitles[agentType],
      version: adcpVersion,
      description: agentDescriptions[agentType],
      contact: {
        name: 'AdCP Support',
        url: 'https://adcontextprotocol.org',
        email: 'support@adcontextprotocol.org'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    servers: [
      {
        url: agentUrls[agentType],
        description: `${agentTitles[agentType]} Server`
      }
    ],
    paths: {},
    tags: []
  };

  // Collect unique tags
  const tagSet = new Set();
  tasks.forEach(task => tagSet.add(task.tag));
  spec.tags = Array.from(tagSet).map(tag => ({ name: tag }));

  // Generate paths
  tasks.forEach(task => {
    const path = `/mcp/v1/${task.name}`;
    spec.paths[path] = {
      post: generateOperation(task, schemaDir)
    };
  });

  return spec;
}

/**
 * Main execution
 */
console.log('🚀 Generating OpenAPI specifications...\n');

// Generate Sales Agent API
const salesSpec = generateOpenAPISpec('sales', salesAgentTasks, 'media-buy');
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'sales-agent-api.json'),
  JSON.stringify(salesSpec, null, 2)
);
console.log('✅ Generated: openapi/sales-agent-api.json');

// Generate Creative Agent API
const creativeSpec = generateOpenAPISpec('creative', creativeAgentTasks, 'creative');
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'creative-agent-api.json'),
  JSON.stringify(creativeSpec, null, 2)
);
console.log('✅ Generated: openapi/creative-agent-api.json');

// Generate Signals Agent API
const signalsSpec = generateOpenAPISpec('signals', signalsAgentTasks, 'signals');
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'signals-agent-api.json'),
  JSON.stringify(signalsSpec, null, 2)
);
console.log('✅ Generated: openapi/signals-agent-api.json');

console.log('\n✨ OpenAPI specs generated successfully!');
console.log('\nNext steps:');
console.log('1. Review the generated specs in openapi/');
console.log('2. Configure Mintlify to reference these OpenAPI files');
console.log('3. Test the API reference pages in Mintlify dev server');
