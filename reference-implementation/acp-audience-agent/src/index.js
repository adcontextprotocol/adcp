import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from 'dotenv';
import { loadAudiences, loadCatalogs } from './dataLoader.js';
import { AIProviderFactory } from './ai/aiProvider.js';
import { AuthManager } from './auth/authManager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

config();

const configData = JSON.parse(
  await fs.readFile(path.join(__dirname, '../config/config.json'), 'utf-8')
);

const audiences = await loadAudiences();
const catalogs = await loadCatalogs();
const aiProvider = AIProviderFactory.create(configData.ai_provider, configData.ai_config);
const authManager = new AuthManager(configData.oauth);

const GetAudiencesSchema = z.object({
  account_id: z.string().optional(),
  audience_spec: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    categories: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    max_results: z.number().optional().default(10)
  }),
  include_custom: z.boolean().optional().default(true)
});

const ActivateAudienceSchema = z.object({
  account_id: z.string(),
  audience_id: z.string(),
  decisioning_platform: z.string(),
  platform_config: z.record(z.any()).optional()
});

const CheckAudienceStatusSchema = z.object({
  account_id: z.string(),
  audience_id: z.string(),
  activation_id: z.string()
});

const ReportUsageSchema = z.object({
  account_id: z.string(),
  audience_id: z.string(),
  activation_id: z.string(),
  usage_data: z.object({
    impressions: z.number(),
    clicks: z.number().optional(),
    spend: z.number().optional(),
    currency: z.string().optional()
  })
});

const server = new Server(
  {
    name: 'acp-audience-agent',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_audiences',
        description: 'Get available audiences based on specifications',
        inputSchema: GetAudiencesSchema,
      },
      {
        name: 'activate_audience',
        description: 'Activate an audience on a decisioning platform',
        inputSchema: ActivateAudienceSchema,
      },
      {
        name: 'check_audience_status',
        description: 'Check the status of an activated audience',
        inputSchema: CheckAudienceStatusSchema,
      },
      {
        name: 'report_usage',
        description: 'Report usage metrics for an activated audience',
        inputSchema: ReportUsageSchema,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_audiences': {
        const params = GetAudiencesSchema.parse(args);
        const accountId = params.account_id || 'default';
        
        const accountCatalog = catalogs.filter(c => c.account_id === accountId);
        const availableAudiences = audiences.filter(a => 
          accountCatalog.some(c => c.audience_id === a.audience_id)
        );

        let results = [];

        if (params.audience_spec.keywords || params.audience_spec.description) {
          const aiResults = await aiProvider.generateAudiences(
            params.audience_spec,
            { audiences: availableAudiences, catalog: accountCatalog }
          );
          results = aiResults;
        } else {
          results = availableAudiences.slice(0, params.audience_spec.max_results);
        }

        const audiencesWithPricing = results.map(audience => {
          const catalogEntry = accountCatalog.find(c => c.audience_id === audience.audience_id);
          return {
            ...audience,
            pricing: catalogEntry ? {
              cpm: catalogEntry.cpm,
              currency: catalogEntry.currency,
              pct_of_media: catalogEntry.pct_of_media
            } : null
          };
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                audiences: audiencesWithPricing,
                total_count: audiencesWithPricing.length,
                account_id: accountId
              }, null, 2),
            },
          ],
        };
      }

      case 'activate_audience': {
        const params = ActivateAudienceSchema.parse(args);
        
        const activationId = `act_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        console.log(`[STUB] Activating audience ${params.audience_id} on ${params.decisioning_platform}`);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                activation_id: activationId,
                audience_id: params.audience_id,
                platform: params.decisioning_platform,
                status: 'provisioning',
                created_at: new Date().toISOString(),
                message: 'Audience activation initiated successfully'
              }, null, 2),
            },
          ],
        };
      }

      case 'check_audience_status': {
        const params = CheckAudienceStatusSchema.parse(args);
        
        console.log(`[STUB] Checking status for activation ${params.activation_id}`);
        
        const statuses = ['provisioning', 'active', 'paused', 'failed'];
        const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                activation_id: params.activation_id,
                audience_id: params.audience_id,
                status: randomStatus,
                last_updated: new Date().toISOString(),
                details: randomStatus === 'active' ? {
                  match_rate: 0.82,
                  total_matches: 1250000
                } : null
              }, null, 2),
            },
          ],
        };
      }

      case 'report_usage': {
        const params = ReportUsageSchema.parse(args);
        
        console.log(`[STUB] Reporting usage for activation ${params.activation_id}`);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                activation_id: params.activation_id,
                audience_id: params.audience_id,
                usage_reported: true,
                timestamp: new Date().toISOString(),
                usage_summary: params.usage_data,
                message: 'Usage data recorded successfully'
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ACP Audience Agent MCP server running');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});