/**
 * Proof of Concept: AdCP Agent with Dual Protocol Support (MCP + A2A)
 * 
 * This example shows how an AdCP Sales Agent could support both:
 * - MCP for tool-based interactions
 * - A2A for agent-to-agent communication
 */

import express from 'express';
import { MCPServer } from '@modelcontextprotocol/server';
import { A2AServer } from '@a2a/server'; // Hypothetical A2A SDK

class DualProtocolAdCPAgent {
  constructor() {
    this.app = express();
    this.setupMCPServer();
    this.setupA2AServer();
    this.setupDiscovery();
  }

  /**
   * MCP Server - Exposes tools for direct integration
   */
  setupMCPServer() {
    this.mcpServer = new MCPServer({
      name: 'AdCP Sales Agent',
      version: '1.0.0',
    });

    // Register AdCP tools
    this.mcpServer.tool('get_products', {
      description: 'List available advertising products',
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          filters: { type: 'object' }
        }
      },
      handler: async (params) => this.getProducts(params)
    });

    this.mcpServer.tool('create_media_buy', {
      description: 'Create a media buy from selected packages',
      parameters: {
        type: 'object',
        properties: {
          packages: { type: 'array' },
          total_budget: { type: 'number' },
          targeting_overlay: { type: 'object' }
        }
      },
      handler: async (params) => this.createMediaBuy(params)
    });

    // Mount MCP endpoint
    this.app.use('/mcp', this.mcpServer.handler());
  }

  /**
   * A2A Server - Enables agent-to-agent communication
   */
  setupA2AServer() {
    this.a2aServer = new A2AServer({
      agentCard: {
        name: 'AdCP Sales Agent',
        description: 'AI-powered media buying agent for programmatic advertising',
        url: 'https://salesagent.example.com/a2a',
        authentication: ['bearer'],
        supportedInputFormats: ['text/plain', 'application/json'],
        supportedOutputFormats: ['text/plain', 'application/json'],
        skills: [
          {
            name: 'campaign_planning',
            description: 'Plan and create advertising campaigns',
            examples: [
              'Create a $50K CTV campaign targeting sports fans',
              'Plan a holiday campaign with audio and display'
            ]
          },
          {
            name: 'inventory_discovery', 
            description: 'Find available advertising inventory',
            examples: [
              'What premium video inventory is available?',
              'Find audio inventory for drive time'
            ]
          }
        ]
      }
    });

    // Handle A2A tasks
    this.a2aServer.on('task', async (task) => {
      return this.handleA2ATask(task);
    });

    // Mount A2A endpoint
    this.app.use('/a2a', this.a2aServer.handler());
  }

  /**
   * Discovery endpoints for both protocols
   */
  setupDiscovery() {
    // AdCP discovery with A2A extension
    this.app.get('/.well-known/adcp.json', (req, res) => {
      res.json({
        sales: {
          mcp: 'https://salesagent.example.com/mcp',
          a2a: 'https://salesagent.example.com/a2a'
        }
      });
    });

    // A2A Agent Card
    this.app.get('/.well-known/agent.json', (req, res) => {
      res.json(this.a2aServer.agentCard);
    });
  }

  /**
   * Handle A2A tasks by mapping to internal operations
   */
  async handleA2ATask(task) {
    const { message } = task;
    const intent = await this.parseIntent(message);

    switch (intent.type) {
      case 'inventory_search':
        return this.handleInventorySearch(intent, task);
      
      case 'campaign_creation':
        return this.handleCampaignCreation(intent, task);
      
      case 'performance_report':
        return this.handlePerformanceReport(intent, task);
      
      default:
        return this.handleGeneralQuery(message, task);
    }
  }

  /**
   * Example: Handle inventory search via A2A
   */
  async handleInventorySearch(intent, task) {
    // Use the same logic as MCP tool
    const products = await this.getProducts({
      brief: intent.query,
      filters: intent.filters
    });

    // Return A2A response with artifacts
    return {
      status: { state: 'completed' },
      artifacts: [{
        name: 'inventory_results',
        parts: [{
          kind: 'application/json',
          data: products
        }, {
          kind: 'text',
          text: `Found ${products.length} matching products:\n` +
                products.map(p => `- ${p.name}: $${p.cpm} CPM`).join('\n')
        }]
      }]
    };
  }

  /**
   * Example: Handle campaign creation via A2A (async with updates)
   */
  async handleCampaignCreation(intent, task) {
    const { taskId } = task;

    // Send initial acknowledgment
    await task.update({
      status: { state: 'working' },
      message: 'Analyzing campaign requirements...'
    });

    // Discover inventory
    const products = await this.getProducts({
      brief: intent.brief,
      filters: { formats: intent.formats }
    });

    await task.update({
      message: `Found ${products.length} suitable products. Creating media buy...`
    });

    // Create the media buy
    const mediaBuy = await this.createMediaBuy({
      packages: products.slice(0, 3).map(p => p.product_id),
      total_budget: intent.budget,
      targeting_overlay: intent.targeting
    });

    // Return completed task with results
    return {
      status: { state: 'completed' },
      artifacts: [{
        name: 'media_buy_confirmation',
        parts: [{
          kind: 'application/json',
          data: mediaBuy
        }, {
          kind: 'text',
          text: `Campaign created successfully!\n` +
                `Media Buy ID: ${mediaBuy.media_buy_id}\n` +
                `Status: ${mediaBuy.status}\n` +
                `Next steps: ${mediaBuy.next_steps.join(', ')}`
        }]
      }]
    };
  }

  /**
   * Parse natural language or structured messages into intents
   */
  async parseIntent(message) {
    // In production, this would use NLP or LLM
    const text = message.parts[0]?.text || '';
    
    if (text.includes('inventory') || text.includes('available')) {
      return { 
        type: 'inventory_search',
        query: text,
        filters: this.extractFilters(text)
      };
    }
    
    if (text.includes('create') || text.includes('campaign')) {
      return {
        type: 'campaign_creation',
        brief: text,
        budget: this.extractBudget(text),
        formats: this.extractFormats(text),
        targeting: this.extractTargeting(text)
      };
    }

    return { type: 'general', query: text };
  }

  /**
   * Core business logic (shared between protocols)
   */
  async getProducts(params) {
    // Implementation would connect to actual ad platforms
    return [
      {
        product_id: 'ctv_premium_sports',
        name: 'Connected TV - Sports Premium',
        description: 'Premium CTV inventory on sports content',
        formats: [{ format_id: 'video_standard', name: 'Standard Video' }],
        cpm: 45.00,
        min_spend: 10000,
        brief_relevance: 'Matches sports audience request'
      },
      // ... more products
    ];
  }

  async createMediaBuy(params) {
    // Implementation would create actual campaigns
    return {
      media_buy_id: 'mb_' + Date.now(),
      status: 'pending_activation',
      creative_deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      detail: 'Media buy created successfully',
      next_steps: [
        'Upload creative assets before deadline',
        'Assets will be reviewed by ad server',
        'Campaign will auto-activate after approval'
      ]
    };
  }

  // Helper methods
  extractBudget(text) {
    const match = text.match(/\$?([\d,]+)k?/i);
    if (match) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      return text.toLowerCase().includes('k') ? value * 1000 : value;
    }
    return 50000; // default
  }

  extractFormats(text) {
    const formats = [];
    if (text.includes('video') || text.includes('ctv')) formats.push('video');
    if (text.includes('audio')) formats.push('audio');
    if (text.includes('display')) formats.push('display');
    return formats.length ? formats : ['video'];
  }

  extractTargeting(text) {
    // Simple extraction - in production would be more sophisticated
    const targeting = {};
    
    if (text.includes('sports')) {
      targeting.content_category_any_of = ['IAB17']; // Sports
    }
    
    const geoMatch = text.match(/in (\w+)/i);
    if (geoMatch) {
      targeting.geo_region_any_of = [geoMatch[1].toUpperCase()];
    }
    
    return targeting;
  }

  start(port = 3000) {
    this.app.listen(port, () => {
      console.log(`Dual-protocol AdCP agent running on port ${port}`);
      console.log(`- MCP endpoint: http://localhost:${port}/mcp`);
      console.log(`- A2A endpoint: http://localhost:${port}/a2a`);
      console.log(`- Discovery: http://localhost:${port}/.well-known/adcp.json`);
      console.log(`- Agent Card: http://localhost:${port}/.well-known/agent.json`);
    });
  }
}

// Start the server
const agent = new DualProtocolAdCPAgent();
agent.start();

/**
 * Example usage from different clients:
 * 
 * 1. MCP Client (current AdCP orchestrators):
 *    POST /mcp
 *    {
 *      "method": "get_products",
 *      "params": { "brief": "sports inventory" }
 *    }
 * 
 * 2. A2A Client (any A2A-compatible agent):
 *    POST /a2a
 *    {
 *      "jsonrpc": "2.0",
 *      "method": "message/send",
 *      "params": {
 *        "message": {
 *          "parts": [{ 
 *            "kind": "text", 
 *            "text": "Find sports inventory for a $50K campaign"
 *          }]
 *        }
 *      }
 *    }
 */