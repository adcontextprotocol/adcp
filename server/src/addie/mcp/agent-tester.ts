/**
 * AdCP Agent E2E Tester
 *
 * Provides comprehensive end-to-end testing of AdCP agents (sales, creative, signals).
 * Replaces the testing.adcontextprotocol.org harness with conversational testing via Addie.
 *
 * Features:
 * - Channel-aware testing (only tests features the agent supports)
 * - Optional dry-run mode (real testing requires actual media buys)
 * - Comprehensive scenario coverage based on AdCP spec
 * - Schema validation via @adcp/client
 */

import { AdCPClient } from '@adcp/client';
import { logger } from '../../logger.js';

// Generic task result from executeTask - we use any for data since responses vary by task
interface TaskResult {
  success: boolean;
  data?: any;
  error?: string;
}

// Test scenarios that can be run
export type TestScenario =
  | 'health_check'           // Just check if agent responds
  | 'discovery'              // get_products, list_creative_formats, list_authorized_properties
  | 'create_media_buy'       // Discovery + create a test media buy
  | 'full_sales_flow'        // Full lifecycle: discovery -> create -> update -> delivery
  | 'creative_sync'          // Test sync_creatives flow
  | 'creative_inline'        // Test inline creatives in create_media_buy
  | 'creative_reference'     // Test reference creatives (creative_ids)
  | 'pricing_models'         // Test different pricing models the agent supports
  | 'creative_flow'          // Creative agent: list_formats -> build -> preview
  | 'signals_flow'           // Signals agent: get_signals -> activate
  // Edge case testing scenarios
  | 'error_handling'         // Test agent returns proper error responses
  | 'validation'             // Test schema validation (invalid inputs should be rejected)
  | 'pricing_edge_cases'     // Test auction vs fixed pricing, min spend, bid_price requirements
  | 'temporal_validation'    // Test date/time ordering and format validation
  // Behavioral analysis scenarios
  | 'behavior_analysis'      // Analyze agent behavior: auth requirements, brief relevance, filtering
  // Response consistency scenarios
  | 'response_consistency';  // Check for schema errors, pagination bugs, data mismatches

export interface TestOptions {
  // Custom brief for product discovery
  brief?: string;
  // Budget for test media buy (default: 1000)
  budget?: number;
  // Specific format IDs to test
  format_ids?: string[];
  // Test session ID for isolation
  test_session_id?: string;
  // Whether to use dry-run mode (default: true for safety)
  dry_run?: boolean;
  // Channels to focus on (if not specified, tests all agent supports)
  channels?: string[];
  // Specific pricing models to test
  pricing_models?: string[];
  // Authentication for agents that require it
  auth?: {
    type: 'bearer';
    token: string;
  };
}

export interface TestStepResult {
  step: string;
  task?: string;
  passed: boolean;
  duration_ms: number;
  details?: string;
  error?: string;
  response_preview?: string;
  // For tracking what was created (for cleanup or follow-up)
  created_id?: string;
}

export interface AgentProfile {
  name: string;
  tools: string[];
  channels?: string[];
  pricing_models?: string[];
  format_ids?: string[];
  delivery_types?: string[];
}

export interface TestResult {
  agent_url: string;
  scenario: TestScenario;
  overall_passed: boolean;
  steps: TestStepResult[];
  summary: string;
  total_duration_ms: number;
  tested_at: string;
  // Agent profile discovered during testing
  agent_profile?: AgentProfile;
  // Was this run in dry-run mode?
  dry_run: boolean;
}

/**
 * Create a test client for an agent
 */
function createTestClient(
  agentUrl: string,
  protocol: 'mcp' | 'a2a' = 'mcp',
  options: TestOptions = {}
) {
  const headers: Record<string, string> = {};

  // Dry-run is true by default for safety
  if (options.dry_run !== false) {
    headers['X-Dry-Run'] = 'true';
  }

  if (options.test_session_id) {
    headers['X-Test-Session-ID'] = options.test_session_id;
  }

  // Build agent config with auth_token if provided
  const agentConfig: {
    id: string;
    name: string;
    agent_uri: string;
    protocol: 'mcp' | 'a2a';
    auth_token?: string;
  } = {
    id: 'test',
    name: 'E2E Test Client',
    agent_uri: agentUrl,
    protocol,
  };

  // Add auth_token to agent config - the library will use it automatically
  if (options.auth?.type === 'bearer' && options.auth?.token) {
    agentConfig.auth_token = options.auth.token;
  }

  const multiClient = new AdCPClient([agentConfig], {
    headers,
  });

  return multiClient.agent('test');
}

/**
 * Run a single test step with timing
 */
async function runStep<T>(
  stepName: string,
  taskName: string | undefined,
  fn: () => Promise<T>
): Promise<{ result?: T; step: TestStepResult }> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    return {
      result,
      step: {
        step: stepName,
        task: taskName,
        passed: true,
        duration_ms: duration,
      },
    };
  } catch (error) {
    const duration = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      step: {
        step: stepName,
        task: taskName,
        passed: false,
        duration_ms: duration,
        error: errorMessage,
      },
    };
  }
}

/**
 * Discover agent profile - what capabilities does this agent have?
 */
async function discoverAgentProfile(
  client: ReturnType<typeof createTestClient>
): Promise<{ profile: AgentProfile; step: TestStepResult }> {
  const { result: agentInfo, step } = await runStep(
    'Discover agent capabilities',
    'getAgentInfo',
    () => client.getAgentInfo()
  );

  const profile: AgentProfile = {
    name: agentInfo?.name || 'Unknown',
    tools: agentInfo?.tools?.map((t: { name: string }) => t.name) || [],
  };

  if (agentInfo) {
    step.details = `Agent: ${profile.name}, Tools: ${profile.tools.length}`;
    step.response_preview = JSON.stringify({
      name: profile.name,
      tools: profile.tools,
    }, null, 2);
  }

  return { profile, step };
}

/**
 * Discover what channels, pricing models, formats the agent supports
 * by calling get_products and analyzing the response
 */
async function discoverAgentCapabilities(
  client: ReturnType<typeof createTestClient>,
  profile: AgentProfile,
  options: TestOptions
): Promise<{ capabilities: Partial<AgentProfile>; steps: TestStepResult[] }> {
  const steps: TestStepResult[] = [];
  const capabilities: Partial<AgentProfile> = {};

  if (!profile.tools.includes('get_products')) {
    return { capabilities, steps };
  }

  const brief = options.brief || 'Show me all available advertising products across all channels';
  // Include brand_manifest as some agents require it (e.g., tenant-specific agents)
  const getProductsParams: Record<string, unknown> = {
    brief,
    brand_manifest: {
      name: 'E2E Test Brand',
      url: 'https://test.example.com',
    },
  };
  const { result, step } = await runStep<TaskResult>(
    'Discover products for capability analysis',
    'get_products',
    async () => client.executeTask('get_products', getProductsParams) as Promise<TaskResult>
  );

  if (result?.success && result?.data?.products) {
    const products = result.data.products as any[];

    // Extract unique channels
    const channels = new Set<string>();
    const pricingModels = new Set<string>();
    const formatIds = new Set<string>();
    const deliveryTypes = new Set<string>();

    for (const product of products) {
      // Channels from product
      if (product.channels) {
        for (const ch of product.channels) {
          channels.add(ch);
        }
      }
      // Delivery type
      if (product.delivery_type) {
        deliveryTypes.add(product.delivery_type);
      }
      // Pricing models
      if (product.pricing_options) {
        for (const po of product.pricing_options) {
          if (po.model) pricingModels.add(po.model);
        }
      }
      // Format IDs
      if (product.format_ids) {
        for (const fid of product.format_ids) {
          const id = typeof fid === 'string' ? fid : fid.id;
          if (id) formatIds.add(id);
        }
      }
    }

    capabilities.channels = Array.from(channels);
    capabilities.pricing_models = Array.from(pricingModels);
    capabilities.format_ids = Array.from(formatIds);
    capabilities.delivery_types = Array.from(deliveryTypes);

    step.details = `Found ${products.length} products across ${channels.size} channel(s), ${pricingModels.size} pricing model(s)`;
    step.response_preview = JSON.stringify({
      products_count: products.length,
      channels: capabilities.channels,
      pricing_models: capabilities.pricing_models,
      delivery_types: capabilities.delivery_types,
      format_count: capabilities.format_ids?.length,
    }, null, 2);
  } else if (result && !result.success) {
    step.passed = false;
    step.error = result.error || 'get_products failed';
  }

  steps.push(step);
  return { capabilities, steps };
}

/**
 * Test: Health Check
 * Verifies the agent is responding and has an agent card
 */
async function testHealthCheck(agentUrl: string, options: TestOptions): Promise<TestStepResult[]> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { step } = await discoverAgentProfile(client);
  steps.push(step);

  return steps;
}

/**
 * Test: Discovery
 * Tests product discovery, format listing, and property listing
 */
async function testDiscovery(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  // Discover agent profile
  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Discover capabilities
  const { capabilities, steps: capSteps } = await discoverAgentCapabilities(client, profile, options);
  steps.push(...capSteps);

  // Merge capabilities into profile
  Object.assign(profile, capabilities);

  // List creative formats (if available)
  if (profile.tools.includes('list_creative_formats')) {
    const { result, step } = await runStep<TaskResult>(
      'List creative formats',
      'list_creative_formats',
      async () => client.executeTask('list_creative_formats', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const formatCount = data.format_ids?.length || data.formats?.length || 0;
      const creativeAgents = data.creative_agents || [];
      step.details = `Found ${formatCount} format(s), ${creativeAgents.length} creative agent(s)`;
      step.response_preview = JSON.stringify({
        format_ids: (data.format_ids || data.formats?.map((f: any) => f.format_id))?.slice(0, 5),
        creative_agents: creativeAgents.map((a: any) => a.agent_url || a.url),
      }, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_creative_formats returned unsuccessful result';
    }
    steps.push(step);
  }

  // List authorized properties (if available)
  if (profile.tools.includes('list_authorized_properties')) {
    const { result, step } = await runStep<TaskResult>(
      'List authorized properties',
      'list_authorized_properties',
      async () => client.executeTask('list_authorized_properties', {}) as Promise<TaskResult>
    );

    const properties = result?.data?.authorized_properties as any[] | undefined;
    if (result?.success && properties) {
      step.details = `Found ${properties.length} authorized propert(ies)`;
      step.response_preview = JSON.stringify({
        properties_count: properties.length,
        domains: properties.slice(0, 3).map((p: any) => p.domain),
      }, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_authorized_properties returned unsuccessful result';
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Find a suitable product for testing based on options
 */
function selectProduct(products: any[], options: TestOptions): any | null {
  // If channels specified, filter to matching products
  let candidates = products;

  if (options.channels?.length) {
    candidates = products.filter(p =>
      p.channels?.some((ch: string) => options.channels!.includes(ch))
    );
  }

  // If pricing models specified, filter further
  if (options.pricing_models?.length) {
    candidates = candidates.filter(p =>
      p.pricing_options?.some((po: any) =>
        options.pricing_models!.includes(po.model)
      )
    );
  }

  // Return first matching or first product
  return candidates[0] || products[0] || null;
}

/**
 * Select a pricing option from a product
 */
function selectPricingOption(product: any, preferredModels?: string[]): any | null {
  const options = product.pricing_options || [];

  if (preferredModels?.length) {
    const preferred = options.find((po: any) => preferredModels.includes(po.model));
    if (preferred) return preferred;
  }

  return options[0] || null;
}

/**
 * Build a create_media_buy request
 */
function buildCreateMediaBuyRequest(
  product: any,
  pricingOption: any,
  options: TestOptions,
  extras: {
    inline_creatives?: any[];
    creative_ids?: string[];
  } = {}
): any {
  const budget = options.budget || 1000;
  const now = new Date();
  const startTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
  const endTime = new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days later

  const isAuction = pricingOption.model === 'auction' ||
                    pricingOption.is_fixed === false ||
                    pricingOption.floor_price !== undefined;

  const packageRequest: any = {
    buyer_ref: `pkg-test-${Date.now()}`,
    product_id: product.product_id,
    budget,
    pricing_option_id: pricingOption.pricing_option_id,
  };

  // Add bid_price if auction-based
  if (isAuction && pricingOption.floor_price) {
    packageRequest.bid_price = pricingOption.floor_price * 1.5;
  }

  // Add inline creatives if provided
  if (extras.inline_creatives?.length) {
    packageRequest.creatives = extras.inline_creatives;
  }

  // Add creative references if provided
  if (extras.creative_ids?.length) {
    packageRequest.creative_ids = extras.creative_ids;
  }

  return {
    buyer_ref: `e2e-test-${Date.now()}`,
    brand_manifest: {
      name: 'E2E Test Brand',
      url: 'https://test.example.com',
    },
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    packages: [packageRequest],
  };
}

/**
 * Test: Create Media Buy
 * Discovers products, then creates a test media buy
 */
async function testCreateMediaBuy(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile; mediaBuyId?: string }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  // First run discovery
  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.tools.includes('create_media_buy')) {
    steps.push({
      step: 'Create media buy',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy',
    });
    return { steps, profile };
  }

  // Get products
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for media buy',
    'get_products',
    async () => client.executeTask('get_products', {
      brief: options.brief || 'Looking for display advertising products',
      brand_manifest: {
        name: 'E2E Test Brand',
        url: 'https://test.example.com',
      },
    }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
  if (!productsResult?.success || !products?.length) {
    steps.push({
      step: 'Create media buy',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No products available to create media buy',
    });
    return { steps, profile };
  }

  const product = selectProduct(products, options);
  const pricingOption = selectPricingOption(product, options.pricing_models);

  if (!pricingOption) {
    steps.push({
      step: 'Create media buy',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: `Product "${product.name}" has no pricing options`,
    });
    return { steps, profile };
  }

  const createRequest = buildCreateMediaBuyRequest(product, pricingOption, options);

  // Create the media buy
  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create media buy',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', createRequest) as Promise<TaskResult>
  );

  let mediaBuyId: string | undefined;

  if (createResult?.success && createResult?.data) {
    const mediaBuy = createResult.data as any;
    mediaBuyId = mediaBuy.media_buy_id || mediaBuy.media_buy?.media_buy_id;
    const status = mediaBuy.status || mediaBuy.media_buy?.status;
    const packages = mediaBuy.packages || mediaBuy.media_buy?.packages;
    createStep.details = `Created media buy: ${mediaBuyId}, status: ${status}`;
    createStep.created_id = mediaBuyId;
    createStep.response_preview = JSON.stringify({
      media_buy_id: mediaBuyId,
      status,
      packages_count: packages?.length,
      pricing_model: pricingOption.model,
      product_name: product.name,
    }, null, 2);
  } else if (createResult && !createResult.success) {
    createStep.passed = false;
    createStep.error = createResult.error || 'create_media_buy returned unsuccessful result';
  }
  steps.push(createStep);

  return { steps, profile, mediaBuyId };
}

/**
 * Test: Full Sales Flow
 * Complete lifecycle: discovery -> create -> update -> delivery
 */
async function testFullSalesFlow(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  // Run create media buy flow first
  const { steps: createSteps, profile, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    return { steps, profile };
  }

  // Test update_media_buy if available
  if (profile?.tools.includes('update_media_buy')) {
    const { result: updateResult, step: updateStep } = await runStep<TaskResult>(
      'Update media buy (increase budget)',
      'update_media_buy',
      async () => client.executeTask('update_media_buy', {
        media_buy_id: mediaBuyId,
        packages: [{
          package_id: 'pkg-0',
          budget: (options.budget || 1000) * 1.5,
        }],
      }) as Promise<TaskResult>
    );

    if (updateResult?.success && updateResult?.data) {
      const data = updateResult.data as any;
      const status = data.status || data.media_buy?.status;
      updateStep.details = `Updated media buy, status: ${status}`;
      updateStep.response_preview = JSON.stringify({
        media_buy_id: data.media_buy_id || data.media_buy?.media_buy_id,
        status,
      }, null, 2);
    } else if (updateResult && !updateResult.success) {
      updateStep.passed = false;
      updateStep.error = updateResult.error || 'update_media_buy returned unsuccessful result';
    }
    steps.push(updateStep);
  }

  // Test get_media_buy_delivery if available
  if (profile?.tools.includes('get_media_buy_delivery')) {
    const { result: deliveryResult, step: deliveryStep } = await runStep<TaskResult>(
      'Get delivery metrics',
      'get_media_buy_delivery',
      async () => client.executeTask('get_media_buy_delivery', {
        media_buy_ids: [mediaBuyId],
      }) as Promise<TaskResult>
    );

    if (deliveryResult?.success && deliveryResult?.data) {
      const delivery = deliveryResult.data as any;
      deliveryStep.details = `Retrieved delivery metrics`;
      deliveryStep.response_preview = JSON.stringify({
        has_deliveries: !!(delivery.deliveries?.length || delivery.media_buys?.length),
      }, null, 2);
    } else if (deliveryResult && !deliveryResult.success) {
      deliveryStep.passed = false;
      deliveryStep.error = deliveryResult.error || 'get_media_buy_delivery returned unsuccessful result';
    }
    steps.push(deliveryStep);
  }

  return { steps, profile };
}

/**
 * Test: Creative Sync Flow
 * Tests sync_creatives separately from create_media_buy
 */
async function testCreativeSync(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  // Discover profile
  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profile.tools.includes('sync_creatives')) {
    steps.push({
      step: 'Sync creatives',
      task: 'sync_creatives',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support sync_creatives',
    });
    return { steps, profile };
  }

  // Get format info first
  let formatId = 'display_300x250'; // Default
  if (profile.tools.includes('list_creative_formats')) {
    const { result: formatsResult } = await runStep<TaskResult>(
      'Get formats for creative',
      'list_creative_formats',
      async () => client.executeTask('list_creative_formats', {}) as Promise<TaskResult>
    );

    if (formatsResult?.success && formatsResult?.data) {
      const data = formatsResult.data as any;
      const firstFormat = data.format_ids?.[0] || data.formats?.[0];
      if (firstFormat) {
        formatId = typeof firstFormat === 'string' ? firstFormat : (firstFormat.id || firstFormat.format_id);
      }
    }
  }

  // Test sync_creatives with a simple creative
  // Assets must be an object keyed by asset_role, not an array
  const testCreative = {
    creative_id: `test-creative-${Date.now()}`,
    name: 'E2E Test Creative',
    format_id: formatId,
    assets: {
      primary: {
        url: 'https://via.placeholder.com/300x250',
        width: 300,
        height: 250,
        format: 'png',
      },
    },
  };

  const { result: syncResult, step: syncStep } = await runStep<TaskResult>(
    'Sync creative to library',
    'sync_creatives',
    async () => client.executeTask('sync_creatives', {
      creatives: [testCreative],
    }) as Promise<TaskResult>
  );

  if (syncResult?.success && syncResult?.data) {
    const data = syncResult.data as any;
    const creatives = data.creatives || [];
    const actions = creatives.map((c: any) => c.action);
    syncStep.details = `Synced ${creatives.length} creative(s), actions: ${actions.join(', ')}`;
    syncStep.response_preview = JSON.stringify({
      creatives_count: creatives.length,
      actions: actions,
      creative_ids: creatives.map((c: any) => c.creative_id),
    }, null, 2);
  } else if (syncResult && !syncResult.success) {
    syncStep.passed = false;
    syncStep.error = syncResult.error || 'sync_creatives returned unsuccessful result';
  }
  steps.push(syncStep);

  // Test list_creatives if available
  if (profile.tools.includes('list_creatives')) {
    const { result: listResult, step: listStep } = await runStep<TaskResult>(
      'List creatives in library',
      'list_creatives',
      async () => client.executeTask('list_creatives', {}) as Promise<TaskResult>
    );

    if (listResult?.success && listResult?.data) {
      const data = listResult.data as any;
      const creatives = data.creatives || [];
      const querySummary = data.query_summary;
      const totalMatching = querySummary?.total_matching;
      const returned = querySummary?.returned ?? creatives.length;

      // Check for pagination bug: total_matching > 0 but returned = 0
      if (totalMatching !== undefined && totalMatching > 0 && returned === 0) {
        listStep.passed = false;
        listStep.error = `Pagination bug: query_summary shows ${totalMatching} total_matching but returned ${returned} creatives`;
        listStep.response_preview = JSON.stringify({
          total_matching: totalMatching,
          returned,
          creatives_count: creatives.length,
          pagination: data.pagination,
        }, null, 2);
      } else {
        listStep.details = `Found ${creatives.length} creative(s) in library`;
        listStep.response_preview = JSON.stringify({
          creatives_count: creatives.length,
          total_matching: totalMatching,
          statuses: Array.from(new Set(creatives.map((c: any) => c.status))),
        }, null, 2);
      }
    } else if (listResult && !listResult.success) {
      listStep.passed = false;
      listStep.error = listResult.error || 'list_creatives returned unsuccessful result';
    }
    steps.push(listStep);
  }

  return { steps, profile };
}

/**
 * Test: Creative Inline Flow
 * Tests providing creatives inline in create_media_buy
 */
async function testCreativeInline(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  // Discovery first
  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.tools.includes('create_media_buy')) {
    steps.push({
      step: 'Create media buy with inline creatives',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy',
    });
    return { steps, profile };
  }

  // Get products
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products',
    'get_products',
    async () => client.executeTask('get_products', {
      brief: options.brief || 'Looking for display advertising products',
      brand_manifest: {
        name: 'E2E Test Brand',
        url: 'https://test.example.com',
      },
    }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
  if (!products?.length) {
    steps.push({
      step: 'Create media buy with inline creatives',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No products available',
    });
    return { steps, profile };
  }

  const product = selectProduct(products, options);
  const pricingOption = selectPricingOption(product, options.pricing_models);

  if (!pricingOption) {
    steps.push({
      step: 'Create media buy with inline creatives',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No pricing options available',
    });
    return { steps, profile };
  }

  // Build inline creative
  const formatId = product.format_ids?.[0];
  const formatIdValue = typeof formatId === 'string' ? formatId : (formatId?.id || 'display_300x250');

  // Assets must be an object keyed by asset_role, not an array
  const inlineCreative = {
    creative_id: `inline-creative-${Date.now()}`,
    name: 'Inline Test Creative',
    format_id: formatIdValue,
    assets: {
      primary: {
        url: 'https://via.placeholder.com/300x250',
        width: 300,
        height: 250,
        format: 'png',
      },
    },
  };

  const createRequest = buildCreateMediaBuyRequest(product, pricingOption, options, {
    inline_creatives: [inlineCreative],
  });

  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create media buy with inline creatives',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', createRequest) as Promise<TaskResult>
  );

  if (createResult?.success && createResult?.data) {
    const mediaBuy = createResult.data as any;
    const mediaBuyId = mediaBuy.media_buy_id || mediaBuy.media_buy?.media_buy_id;
    createStep.details = `Created media buy with inline creative: ${mediaBuyId}`;
    createStep.response_preview = JSON.stringify({
      media_buy_id: mediaBuyId,
      status: mediaBuy.status || mediaBuy.media_buy?.status,
      inline_creative_used: true,
    }, null, 2);
  } else if (createResult && !createResult.success) {
    createStep.passed = false;
    createStep.error = createResult.error || 'create_media_buy returned unsuccessful result';
  }
  steps.push(createStep);

  return { steps, profile };
}

/**
 * Test: Pricing Models
 * Tests different pricing models the agent supports
 */
async function testPricingModels(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  // Discovery first
  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.pricing_models?.length) {
    steps.push({
      step: 'Test pricing models',
      passed: false,
      duration_ms: 0,
      error: 'No pricing models discovered',
    });
    return { steps, profile };
  }

  // Get products to analyze pricing
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for pricing analysis',
    'get_products',
    async () => client.executeTask('get_products', {
      brief: 'Show all products',
      brand_manifest: {
        name: 'E2E Test Brand',
        url: 'https://test.example.com',
      },
    }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
  if (!products?.length) {
    return { steps, profile };
  }

  // Analyze pricing model distribution
  const pricingAnalysis: Record<string, { count: number; fixed: number; auction: number }> = {};

  for (const product of products) {
    for (const po of (product.pricing_options || [])) {
      const model = po.model || 'unknown';
      if (!pricingAnalysis[model]) {
        pricingAnalysis[model] = { count: 0, fixed: 0, auction: 0 };
      }
      pricingAnalysis[model].count++;
      if (po.is_fixed === false || po.floor_price !== undefined) {
        pricingAnalysis[model].auction++;
      } else {
        pricingAnalysis[model].fixed++;
      }
    }
  }

  steps.push({
    step: 'Analyze pricing models',
    passed: true,
    duration_ms: 0,
    details: `Found ${Object.keys(pricingAnalysis).length} pricing model(s)`,
    response_preview: JSON.stringify(pricingAnalysis, null, 2),
  });

  return { steps, profile };
}

/**
 * Test: Creative Flow (for creative agents)
 */
async function testCreativeFlow(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // List creative formats
  if (profile.tools.includes('list_creative_formats')) {
    const { result, step } = await runStep<TaskResult>(
      'List creative formats',
      'list_creative_formats',
      async () => client.executeTask('list_creative_formats', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const formats = data.formats || [];
      step.details = `Found ${formats.length} format(s)`;
      step.response_preview = JSON.stringify({
        formats_count: formats.length,
        format_names: formats.slice(0, 5).map((f: any) => f.name || f.format_id),
      }, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_creative_formats failed';
    }
    steps.push(step);
  }

  // Build creative (if available)
  if (profile.tools.includes('build_creative')) {
    const { result, step } = await runStep<TaskResult>(
      'Build creative',
      'build_creative',
      async () => client.executeTask('build_creative', {
        format_id: options.format_ids?.[0] || 'display_300x250',
        brand_manifest: {
          name: 'E2E Test Brand',
          url: 'https://test.example.com',
          tagline: 'Testing the future of advertising',
        },
        prompt: 'Create a simple display ad for a tech product',
      }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Built creative successfully`;
      step.response_preview = JSON.stringify({
        creative_id: data.creative_id || data.creative?.creative_id,
        format_id: data.format_id || data.creative?.format_id,
      }, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'build_creative failed';
    }
    steps.push(step);
  }

  // Preview creative (if available)
  if (profile.tools.includes('preview_creative')) {
    const { result, step } = await runStep<TaskResult>(
      'Preview creative',
      'preview_creative',
      async () => client.executeTask('preview_creative', {
        creative: {
          format_id: options.format_ids?.[0] || 'display_300x250',
          name: 'Test Creative',
          assets: [],
        },
      }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Generated preview`;
      step.response_preview = JSON.stringify({
        has_renders: !!(data.renders?.length || data.preview_url),
      }, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'preview_creative failed';
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Signals Flow (for signals agents)
 */
async function testSignalsFlow(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Get signals
  if (profile.tools.includes('get_signals')) {
    const { result, step } = await runStep<TaskResult>(
      'Get signals',
      'get_signals',
      async () => client.executeTask('get_signals', {
        brief: 'Looking for audience segments interested in technology',
      }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const signals = data.signals || [];
      step.details = `Found ${signals.length} signal(s)`;
      step.response_preview = JSON.stringify({
        signals_count: signals.length,
        signal_names: signals.slice(0, 3).map((s: any) => s.name),
      }, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'get_signals failed';
    }
    steps.push(step);
  }

  // Activate signal (if available)
  if (profile.tools.includes('activate_signal')) {
    const { result, step } = await runStep<TaskResult>(
      'Activate signal',
      'activate_signal',
      async () => client.executeTask('activate_signal', {
        signal_id: 'test-signal-id',
        destination: {
          platform: 'test-platform',
          account_id: 'test-account',
        },
      }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Signal activation submitted`;
      step.response_preview = JSON.stringify({
        status: data.status || data.deployment?.status,
      }, null, 2);
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'activate_signal failed';
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Error Handling
 * Verifies the agent returns proper discriminated union error responses
 */
async function testErrorHandling(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test 1: Invalid product_id in create_media_buy should return proper error
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid product_id error response',
      'create_media_buy',
      async () => client.executeTask('create_media_buy', {
        buyer_ref: `error-test-${Date.now()}`,
        brand_manifest: {
          name: 'Error Test Brand',
          url: 'https://test.example.com',
        },
        start_time: new Date(Date.now() + 86400000).toISOString(),
        end_time: new Date(Date.now() + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-error-test',
          product_id: 'NONEXISTENT_PRODUCT_ID_12345',
          budget: 1000,
          pricing_option_id: 'nonexistent-pricing',
        }],
      }) as Promise<TaskResult>
    );

    // For error handling test, we EXPECT an error - passing means the error was returned properly
    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly returned error for invalid product_id';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted invalid product_id - should have returned error';
    } else {
      step.passed = false;
      step.error = 'Agent returned neither success nor proper error response';
    }
    steps.push(step);
  }

  // Test 2: Missing required field in get_products (brief is often required)
  if (profile.tools.includes('get_products')) {
    const { result, step } = await runStep<TaskResult>(
      'Empty request handling',
      'get_products',
      async () => client.executeTask('get_products', {}) as Promise<TaskResult>
    );

    // Some agents may accept empty requests, others may require brief
    if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts empty get_products request (permissive)';
    } else if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent requires brief/brand_manifest (stricter validation)';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else {
      step.passed = false;
      step.error = 'Unclear response - neither success nor proper error';
    }
    steps.push(step);
  }

  // Test 3: Invalid format_id in sync_creatives
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid format_id error response',
      'sync_creatives',
      async () => client.executeTask('sync_creatives', {
        creatives: [{
          creative_id: `invalid-format-test-${Date.now()}`,
          name: 'Invalid Format Test',
          format_id: 'TOTALLY_INVALID_FORMAT_ID_999',
          assets: {
            primary: {
              url: 'https://via.placeholder.com/300x250',
              width: 300,
              height: 250,
              format: 'png',
            },
          },
        }],
      }) as Promise<TaskResult>
    );

    // Expect error for invalid format_id
    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly rejected invalid format_id';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else if (result?.success) {
      // Some agents may be permissive and accept any format_id
      step.passed = true;
      step.details = 'Agent accepts unknown format_ids (permissive mode)';
    } else {
      step.passed = false;
      step.error = 'Unclear response for invalid format_id';
    }
    steps.push(step);
  }

  // Test 4: get_media_buy_delivery with non-existent media_buy_id
  if (profile.tools.includes('get_media_buy_delivery')) {
    const { result, step } = await runStep<TaskResult>(
      'Non-existent media_buy_id error',
      'get_media_buy_delivery',
      async () => client.executeTask('get_media_buy_delivery', {
        media_buy_ids: ['NONEXISTENT_MEDIA_BUY_ID_99999'],
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly returned error for non-existent media buy';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else if (result?.success) {
      // Check if it returned empty deliveries (also acceptable)
      const data = result.data as any;
      const deliveries = data?.deliveries || data?.media_buys || [];
      if (deliveries.length === 0) {
        step.passed = true;
        step.details = 'Agent returned empty deliveries for non-existent media buy';
      } else {
        step.passed = false;
        step.error = 'Agent returned deliveries for non-existent media_buy_id';
      }
    } else {
      step.passed = false;
      step.error = 'Unclear response for non-existent media_buy_id';
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Validation
 * Tests that agents properly validate inputs and reject malformed requests
 */
async function testValidation(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test 1: Invalid enum value for pacing
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid pacing enum value',
      'create_media_buy',
      async () => client.executeTask('create_media_buy', {
        buyer_ref: `validation-test-${Date.now()}`,
        brand_manifest: { name: 'Validation Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() + 86400000).toISOString(),
        end_time: new Date(Date.now() + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-validation',
          product_id: 'test-product',
          budget: 1000,
          pricing_option_id: 'test-pricing',
          pacing: 'INVALID_PACING_VALUE' as any, // Invalid - should be even/asap/front_loaded
        }],
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejected invalid pacing enum value';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted invalid pacing value - should validate enums';
    } else {
      step.passed = false;
      step.error = 'Unclear validation response';
    }
    steps.push(step);
  }

  // Test 2: Zero budget package
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Zero budget validation',
      'create_media_buy',
      async () => client.executeTask('create_media_buy', {
        buyer_ref: `zero-budget-test-${Date.now()}`,
        brand_manifest: { name: 'Zero Budget Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() + 86400000).toISOString(),
        end_time: new Date(Date.now() + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-zero-budget',
          product_id: 'test-product',
          budget: 0, // Zero budget - should be rejected or flagged
          pricing_option_id: 'test-pricing',
        }],
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejected zero budget (strict validation)';
    } else if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts zero budget (permissive - schema allows minimum: 0)';
    } else {
      step.passed = false;
      step.error = 'Unclear response for zero budget';
    }
    steps.push(step);
  }

  // Test 3: Negative budget (definitely invalid)
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Negative budget rejection',
      'create_media_buy',
      async () => client.executeTask('create_media_buy', {
        buyer_ref: `negative-budget-test-${Date.now()}`,
        brand_manifest: { name: 'Negative Budget Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() + 86400000).toISOString(),
        end_time: new Date(Date.now() + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-negative',
          product_id: 'test-product',
          budget: -500, // Negative budget - MUST be rejected
          pricing_option_id: 'test-pricing',
        }],
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly rejected negative budget';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'CRITICAL: Agent accepted negative budget - must validate minimum: 0';
    } else {
      step.passed = false;
      step.error = 'Unclear response for negative budget';
    }
    steps.push(step);
  }

  // Test 4: Invalid creative weight (> 100)
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid creative weight (> 100)',
      'sync_creatives',
      async () => client.executeTask('sync_creatives', {
        creatives: [{
          creative_id: `weight-test-${Date.now()}`,
          name: 'Weight Test Creative',
          format_id: 'display_300x250',
          weight: 150, // Invalid - max is 100
          assets: {
            primary: {
              url: 'https://via.placeholder.com/300x250',
              width: 300,
              height: 250,
              format: 'png',
            },
          },
        }],
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejected weight > 100';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted weight > 100 - should validate maximum: 100';
    } else {
      step.passed = false;
      step.error = 'Unclear response for invalid weight';
    }
    steps.push(step);
  }

  // Test 5: Empty creatives array
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Empty creatives array handling',
      'sync_creatives',
      async () => client.executeTask('sync_creatives', {
        creatives: [], // Empty array - should be rejected or return empty
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejected empty creatives array';
    } else if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts empty creatives array (returns empty result)';
    } else {
      step.passed = false;
      step.error = 'Unclear response for empty creatives array';
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Pricing Edge Cases
 * Tests auction vs fixed pricing, min spend requirements, bid_price handling
 */
async function testPricingEdgeCases(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  // First get products to understand pricing options
  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.tools.includes('create_media_buy') || !profile?.tools.includes('get_products')) {
    steps.push({
      step: 'Pricing edge cases',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy or get_products',
    });
    return { steps, profile };
  }

  // Get products to find actual pricing options
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for pricing analysis',
    'get_products',
    async () => client.executeTask('get_products', {
      brief: 'Show all products with pricing details',
      brand_manifest: { name: 'Pricing Test', url: 'https://test.example.com' },
    }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
  if (!products?.length) {
    steps.push({
      step: 'Pricing edge cases',
      passed: false,
      duration_ms: 0,
      error: 'No products available for pricing tests',
    });
    return { steps, profile };
  }

  // Analyze products for auction vs fixed pricing
  const auctionProducts: any[] = [];
  const fixedProducts: any[] = [];
  const productsWithMinSpend: any[] = [];

  for (const product of products) {
    for (const po of (product.pricing_options || [])) {
      if (po.is_fixed === false || po.floor_price !== undefined || po.price_guidance !== undefined) {
        auctionProducts.push({ product, pricingOption: po });
      } else if (po.rate !== undefined) {
        fixedProducts.push({ product, pricingOption: po });
      }
      if (po.min_spend_per_package !== undefined && po.min_spend_per_package > 0) {
        productsWithMinSpend.push({ product, pricingOption: po, minSpend: po.min_spend_per_package });
      }
    }
  }

  steps.push({
    step: 'Analyze pricing options',
    passed: true,
    duration_ms: 0,
    details: `Found ${fixedProducts.length} fixed, ${auctionProducts.length} auction, ${productsWithMinSpend.length} with min spend`,
    response_preview: JSON.stringify({
      fixed_count: fixedProducts.length,
      auction_count: auctionProducts.length,
      min_spend_count: productsWithMinSpend.length,
    }, null, 2),
  });

  // Test 1: Auction pricing without bid_price (should fail)
  if (auctionProducts.length > 0) {
    const { product, pricingOption } = auctionProducts[0];
    const { result, step } = await runStep<TaskResult>(
      'Auction pricing without bid_price',
      'create_media_buy',
      async () => client.executeTask('create_media_buy', {
        buyer_ref: `auction-no-bid-${Date.now()}`,
        brand_manifest: { name: 'Auction Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() + 86400000).toISOString(),
        end_time: new Date(Date.now() + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-auction-no-bid',
          product_id: product.product_id,
          budget: 5000,
          pricing_option_id: pricingOption.pricing_option_id,
          // Intentionally missing bid_price for auction pricing
        }],
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly requires bid_price for auction pricing';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted auction pricing without bid_price - should require it';
    } else {
      step.passed = false;
      step.error = 'Unclear response for missing bid_price';
    }
    steps.push(step);
  }

  // Test 2: Fixed pricing with bid_price (should be ignored or rejected)
  if (fixedProducts.length > 0) {
    const { product, pricingOption } = fixedProducts[0];
    const { result, step } = await runStep<TaskResult>(
      'Fixed pricing with unnecessary bid_price',
      'create_media_buy',
      async () => client.executeTask('create_media_buy', {
        buyer_ref: `fixed-with-bid-${Date.now()}`,
        brand_manifest: { name: 'Fixed Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() + 86400000).toISOString(),
        end_time: new Date(Date.now() + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-fixed-bid',
          product_id: product.product_id,
          budget: 5000,
          pricing_option_id: pricingOption.pricing_option_id,
          bid_price: 15.00, // Unnecessary for fixed pricing
        }],
      }) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = true;
      step.details = 'Agent ignores bid_price for fixed pricing (permissive)';
    } else if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejects bid_price for fixed pricing (strict)';
    } else {
      step.passed = false;
      step.error = 'Unclear response for fixed pricing with bid_price';
    }
    steps.push(step);
  }

  // Test 3: Budget below min_spend_per_package
  if (productsWithMinSpend.length > 0) {
    const { product, pricingOption, minSpend } = productsWithMinSpend[0];
    const underBudget = minSpend * 0.5; // 50% of minimum

    const { result, step } = await runStep<TaskResult>(
      'Budget below min_spend_per_package',
      'create_media_buy',
      async () => client.executeTask('create_media_buy', {
        buyer_ref: `under-min-spend-${Date.now()}`,
        brand_manifest: { name: 'Min Spend Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() + 86400000).toISOString(),
        end_time: new Date(Date.now() + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-under-min',
          product_id: product.product_id,
          budget: underBudget,
          pricing_option_id: pricingOption.pricing_option_id,
        }],
      }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = `Agent rejected budget ${underBudget} below min_spend ${minSpend}`;
    } else if (result?.success) {
      step.passed = false;
      step.error = `Agent accepted budget ${underBudget} below min_spend ${minSpend}`;
    } else {
      step.passed = false;
      step.error = 'Unclear response for under-min-spend budget';
    }
    steps.push(step);
  }

  // Test 4: Bid below floor price for auction
  if (auctionProducts.length > 0) {
    const { product, pricingOption } = auctionProducts[0];
    const floorPrice = pricingOption.floor_price || pricingOption.price_guidance?.floor || 0;

    if (floorPrice > 0) {
      const belowFloor = floorPrice * 0.5; // 50% of floor

      const { result, step } = await runStep<TaskResult>(
        'Bid below floor price',
        'create_media_buy',
        async () => client.executeTask('create_media_buy', {
          buyer_ref: `below-floor-${Date.now()}`,
          brand_manifest: { name: 'Floor Test', url: 'https://test.example.com' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [{
            buyer_ref: 'pkg-below-floor',
            product_id: product.product_id,
            budget: 5000,
            pricing_option_id: pricingOption.pricing_option_id,
            bid_price: belowFloor,
          }],
        }) as Promise<TaskResult>
      );

      if (result && !result.success && result.error) {
        step.passed = true;
        step.details = `Agent rejected bid ${belowFloor} below floor ${floorPrice}`;
      } else if (result?.success) {
        // Some agents may accept and just not win auctions
        step.passed = true;
        step.details = `Agent accepts bid below floor (may not win auctions)`;
      } else {
        step.passed = false;
        step.error = 'Unclear response for below-floor bid';
      }
      steps.push(step);
    }
  }

  return { steps, profile };
}

/**
 * Test: Behavior Analysis
 * Analyzes interesting behavioral characteristics of the agent:
 * - Does it require authentication for get_products?
 * - Does it require brand_manifest to return products?
 * - Are responses filtered based on the brief or is everything returned?
 */
async function testBehaviorAnalysis(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];

  // Create authenticated client for comparison
  const authClient = createTestClient(agentUrl, 'mcp', options);
  const { profile, step: profileStep } = await discoverAgentProfile(authClient);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  if (!profile.tools.includes('get_products')) {
    steps.push({
      step: 'Behavior analysis',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support get_products - cannot analyze behavior',
    });
    return { steps, profile };
  }

  // Test 1: Authentication requirement - call without auth token
  const noAuthOptions: TestOptions = {
    ...options,
    auth: undefined, // Explicitly remove auth
  };
  const noAuthClient = createTestClient(agentUrl, 'mcp', noAuthOptions);

  const { result: noAuthResult, step: noAuthStep } = await runStep<TaskResult>(
    'Get products without authentication',
    'get_products',
    async () => noAuthClient.executeTask('get_products', {
      brief: 'Show me all available products',
      brand_manifest: { name: 'Auth Test', url: 'https://test.example.com' },
    }) as Promise<TaskResult>
  );

  if (noAuthResult?.success && noAuthResult?.data?.products) {
    const products = noAuthResult.data.products as any[];
    noAuthStep.passed = true;
    noAuthStep.details = `No auth required: returned ${products.length} product(s)`;
    noAuthStep.response_preview = JSON.stringify({
      auth_required: false,
      products_returned: products.length,
    }, null, 2);
  } else if (noAuthResult && !noAuthResult.success) {
    noAuthStep.passed = true;
    noAuthStep.details = 'Authentication required for get_products';
    noAuthStep.response_preview = JSON.stringify({
      auth_required: true,
      error: noAuthResult.error,
    }, null, 2);
  } else {
    noAuthStep.passed = false;
    noAuthStep.error = 'Unclear authentication behavior';
  }
  steps.push(noAuthStep);

  // Detect if auth is required - if so, subsequent tests need auth to work
  const authRequired = noAuthResult && !noAuthResult.success &&
    noAuthResult.error?.toLowerCase().includes('auth');

  // Test 2: Brand manifest requirement - call without brand_manifest
  const { result: noBrandResult, step: noBrandStep } = await runStep<TaskResult>(
    'Get products without brand_manifest',
    'get_products',
    async () => authClient.executeTask('get_products', {
      brief: 'Show me all available products',
      // Intentionally no brand_manifest
    }) as Promise<TaskResult>
  );

  if (noBrandResult?.success && noBrandResult?.data?.products) {
    const products = noBrandResult.data.products as any[];
    noBrandStep.passed = true;
    noBrandStep.details = `Brand manifest not required: returned ${products.length} product(s)`;
    noBrandStep.response_preview = JSON.stringify({
      brand_manifest_required: false,
      products_returned: products.length,
    }, null, 2);
  } else if (noBrandResult && !noBrandResult.success) {
    // Check if this is an auth error (same as the no-auth test) or a brand_manifest error
    const isAuthError = noBrandResult.error?.toLowerCase().includes('auth');
    if (isAuthError && authRequired) {
      noBrandStep.passed = true;
      noBrandStep.details = 'Inconclusive: auth failed (cannot test brand_manifest requirement independently)';
      noBrandStep.response_preview = JSON.stringify({
        brand_manifest_required: 'unknown',
        reason: 'Auth token not accepted - cannot isolate brand_manifest requirement',
        error: noBrandResult.error,
      }, null, 2);
    } else {
      noBrandStep.passed = true;
      noBrandStep.details = 'Brand manifest required for get_products';
      noBrandStep.response_preview = JSON.stringify({
        brand_manifest_required: true,
        error: noBrandResult.error,
      }, null, 2);
    }
  } else {
    noBrandStep.passed = false;
    noBrandStep.error = 'Unclear brand_manifest requirement';
  }
  steps.push(noBrandStep);

  // Test 3: Brief relevance - compare generic vs specific briefs
  // Skip these tests if auth is required but failing
  let genericProductCount = 0;
  let specificProductCount = 0;
  let briefTestsSkipped = false;

  if (authRequired && noBrandResult && !noBrandResult.success &&
      noBrandResult.error?.toLowerCase().includes('auth')) {
    // Auth is not working - skip brief relevance tests
    briefTestsSkipped = true;
    const skipStep: TestStepResult = {
      step: 'Brief relevance tests',
      passed: true,
      duration_ms: 0,
      details: 'Skipped: auth token not accepted by agent - cannot test brief filtering',
      response_preview: JSON.stringify({
        skipped: true,
        reason: 'Auth required but token not accepted for get_products',
      }, null, 2),
    };
    steps.push(skipStep);
  } else {
    const { result: genericResult, step: genericStep } = await runStep<TaskResult>(
      'Get products with generic brief',
      'get_products',
      async () => authClient.executeTask('get_products', {
        brief: 'Show me all available advertising products',
        brand_manifest: { name: 'Brief Test', url: 'https://test.example.com' },
      }) as Promise<TaskResult>
    );

    if (genericResult?.success && genericResult?.data?.products) {
      const products = genericResult.data.products as any[];
      genericProductCount = products.length;
      genericStep.passed = true;
      genericStep.details = `Generic brief returned ${products.length} product(s)`;
    } else {
      genericStep.passed = false;
      genericStep.error = genericResult?.error || 'Failed to get products with generic brief';
    }
    steps.push(genericStep);

    // Now try a specific brief and compare
    const { result: specificResult, step: specificStep } = await runStep<TaskResult>(
      'Get products with specific brief',
      'get_products',
      async () => authClient.executeTask('get_products', {
        brief: 'I need video advertising products for automotive brands targeting luxury car buyers aged 35-55',
        brand_manifest: {
          name: 'Luxury Auto Brand',
          url: 'https://test.example.com',
          industry: 'automotive',
          target_audience: 'luxury car buyers aged 35-55',
        },
      }) as Promise<TaskResult>
    );

    if (specificResult?.success && specificResult?.data?.products) {
      const products = specificResult.data.products as any[];
      specificProductCount = products.length;
      specificStep.passed = true;
      specificStep.details = `Specific brief returned ${products.length} product(s)`;

      // Analyze if results are filtered
      const channels = new Set<string>();
      for (const product of products) {
        if (product.channels) {
          for (const ch of product.channels) {
            channels.add(ch);
          }
        }
      }
      specificStep.response_preview = JSON.stringify({
        products_returned: products.length,
        channels: Array.from(channels),
      }, null, 2);
    } else {
      specificStep.passed = false;
      specificStep.error = specificResult?.error || 'Failed to get products with specific brief';
    }
    steps.push(specificStep);
  }

  // Test 4: Analyze filtering behavior based on comparison (skip if auth failed)
  if (!briefTestsSkipped) {
    const filteringAnalysisStep: TestStepResult = {
      step: 'Analyze brief relevance filtering',
      passed: true,
      duration_ms: 0,
    };

    if (genericProductCount > 0 && specificProductCount > 0) {
      if (specificProductCount < genericProductCount) {
        filteringAnalysisStep.details = `Agent filters by brief: generic=${genericProductCount}, specific=${specificProductCount} (${Math.round((1 - specificProductCount / genericProductCount) * 100)}% reduction)`;
        filteringAnalysisStep.response_preview = JSON.stringify({
          filtering_behavior: 'filtered',
          generic_count: genericProductCount,
          specific_count: specificProductCount,
          reduction_percent: Math.round((1 - specificProductCount / genericProductCount) * 100),
        }, null, 2);
      } else if (specificProductCount === genericProductCount) {
        filteringAnalysisStep.details = `Agent returns same products regardless of brief (${genericProductCount} products)`;
        filteringAnalysisStep.response_preview = JSON.stringify({
          filtering_behavior: 'unfiltered',
          generic_count: genericProductCount,
          specific_count: specificProductCount,
          note: 'Same products returned for different briefs',
        }, null, 2);
      } else {
        filteringAnalysisStep.details = `Specific brief returned more products (${specificProductCount} > ${genericProductCount})`;
        filteringAnalysisStep.response_preview = JSON.stringify({
          filtering_behavior: 'expanded',
          generic_count: genericProductCount,
          specific_count: specificProductCount,
          note: 'More products for detailed brief - may include related products',
        }, null, 2);
      }
    } else if (genericProductCount === 0 && specificProductCount === 0) {
      filteringAnalysisStep.details = 'No products returned for either brief';
      filteringAnalysisStep.passed = false;
      filteringAnalysisStep.error = 'Cannot analyze filtering - no products available';
    } else {
      filteringAnalysisStep.details = `Partial results: generic=${genericProductCount}, specific=${specificProductCount}`;
    }
    steps.push(filteringAnalysisStep);
  }

  // Test 5: Channel filtering - test if agent filters by requested channel
  // Skip if auth is not working
  if (!briefTestsSkipped) {
    const { result: channelResult, step: channelStep } = await runStep<TaskResult>(
      'Get products with channel-specific brief',
      'get_products',
      async () => authClient.executeTask('get_products', {
        brief: 'I only want display advertising products, no video or audio',
        brand_manifest: { name: 'Channel Test', url: 'https://test.example.com' },
        channels: ['display'], // Explicit channel filter if supported
      }) as Promise<TaskResult>
    );

    if (channelResult?.success && channelResult?.data?.products) {
      const products = channelResult.data.products as any[];
      const channels = new Set<string>();
      for (const product of products) {
        if (product.channels) {
          for (const ch of product.channels) {
            channels.add(ch);
          }
        }
      }

      const hasOnlyDisplay = channels.size === 1 && channels.has('display');
      const hasDisplay = channels.has('display');

      if (hasOnlyDisplay) {
        channelStep.details = `Agent correctly filtered to display-only: ${products.length} product(s)`;
      } else if (hasDisplay && channels.size > 1) {
        channelStep.details = `Agent included display + other channels: ${Array.from(channels).join(', ')}`;
      } else {
        channelStep.details = `Agent returned channels: ${Array.from(channels).join(', ')} (${products.length} products)`;
      }
      channelStep.response_preview = JSON.stringify({
        products_returned: products.length,
        channels_in_response: Array.from(channels),
        display_only: hasOnlyDisplay,
      }, null, 2);
    } else if (channelResult && !channelResult.success) {
      channelStep.passed = true;
      channelStep.details = 'Channel filter parameter not supported';
      channelStep.response_preview = JSON.stringify({ error: channelResult.error }, null, 2);
    } else {
      channelStep.passed = false;
      channelStep.error = 'Unclear channel filtering behavior';
    }
    steps.push(channelStep);
  }

  return { steps, profile };
}

/**
 * Test: Temporal Validation
 * Tests date/time ordering, format validation, and deadline logic
 */
async function testTemporalValidation(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed || !profile.tools.includes('create_media_buy')) {
    steps.push({
      step: 'Temporal validation',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy',
    });
    return { steps, profile };
  }

  // Test 1: End time before start time (MUST fail)
  const now = Date.now();
  const { result: endBeforeStartResult, step: endBeforeStartStep } = await runStep<TaskResult>(
    'End time before start time',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', {
      buyer_ref: `temporal-test-${Date.now()}`,
      brand_manifest: { name: 'Temporal Test', url: 'https://test.example.com' },
      start_time: new Date(now + 604800000).toISOString(), // 7 days from now
      end_time: new Date(now + 86400000).toISOString(),   // 1 day from now (BEFORE start!)
      packages: [{
        buyer_ref: 'pkg-temporal',
        product_id: 'test-product',
        budget: 1000,
        pricing_option_id: 'test-pricing',
      }],
    }) as Promise<TaskResult>
  );

  if (endBeforeStartResult && !endBeforeStartResult.success && endBeforeStartResult.error) {
    endBeforeStartStep.passed = true;
    endBeforeStartStep.details = 'Agent correctly rejected end_time before start_time';
  } else if (endBeforeStartResult?.success) {
    endBeforeStartStep.passed = false;
    endBeforeStartStep.error = 'CRITICAL: Agent accepted end_time before start_time';
  } else {
    endBeforeStartStep.passed = false;
    endBeforeStartStep.error = 'Unclear response for invalid temporal ordering';
  }
  steps.push(endBeforeStartStep);

  // Test 2: Start time in the past
  const { result: pastStartResult, step: pastStartStep } = await runStep<TaskResult>(
    'Start time in the past',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', {
      buyer_ref: `past-start-${Date.now()}`,
      brand_manifest: { name: 'Past Start Test', url: 'https://test.example.com' },
      start_time: new Date(now - 604800000).toISOString(), // 7 days ago (IN THE PAST!)
      end_time: new Date(now + 604800000).toISOString(),   // 7 days from now
      packages: [{
        buyer_ref: 'pkg-past',
        product_id: 'test-product',
        budget: 1000,
        pricing_option_id: 'test-pricing',
      }],
    }) as Promise<TaskResult>
  );

  if (pastStartResult && !pastStartResult.success && pastStartResult.error) {
    pastStartStep.passed = true;
    pastStartStep.details = 'Agent rejected start_time in the past';
  } else if (pastStartResult?.success) {
    // Some agents may allow past start times for immediate activation
    pastStartStep.passed = true;
    pastStartStep.details = 'Agent accepts past start_time (immediate activation mode)';
  } else {
    pastStartStep.passed = false;
    pastStartStep.error = 'Unclear response for past start_time';
  }
  steps.push(pastStartStep);

  // Test 3: Invalid ISO 8601 date format
  const { result: invalidDateResult, step: invalidDateStep } = await runStep<TaskResult>(
    'Invalid date format',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', {
      buyer_ref: `invalid-date-${Date.now()}`,
      brand_manifest: { name: 'Invalid Date Test', url: 'https://test.example.com' },
      start_time: '01/15/2025', // Invalid - should be ISO 8601
      end_time: new Date(now + 604800000).toISOString(),
      packages: [{
        buyer_ref: 'pkg-invalid-date',
        product_id: 'test-product',
        budget: 1000,
        pricing_option_id: 'test-pricing',
      }],
    }) as Promise<TaskResult>
  );

  if (invalidDateResult && !invalidDateResult.success && invalidDateResult.error) {
    invalidDateStep.passed = true;
    invalidDateStep.details = 'Agent rejected invalid date format';
  } else if (invalidDateResult?.success) {
    invalidDateStep.passed = false;
    invalidDateStep.error = 'Agent accepted non-ISO 8601 date format';
  } else {
    invalidDateStep.passed = false;
    invalidDateStep.error = 'Unclear response for invalid date format';
  }
  steps.push(invalidDateStep);

  // Test 4: Very long campaign duration (edge case)
  const { result: longCampaignResult, step: longCampaignStep } = await runStep<TaskResult>(
    'Very long campaign duration (365 days)',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', {
      buyer_ref: `long-campaign-${Date.now()}`,
      brand_manifest: { name: 'Long Campaign Test', url: 'https://test.example.com' },
      start_time: new Date(now + 86400000).toISOString(),
      end_time: new Date(now + 365 * 86400000).toISOString(), // 365 days!
      packages: [{
        buyer_ref: 'pkg-long',
        product_id: 'test-product',
        budget: 100000,
        pricing_option_id: 'test-pricing',
      }],
    }) as Promise<TaskResult>
  );

  if (longCampaignResult?.success) {
    longCampaignStep.passed = true;
    longCampaignStep.details = 'Agent accepts 365-day campaign';
  } else if (longCampaignResult && !longCampaignResult.success && longCampaignResult.error) {
    longCampaignStep.passed = true;
    longCampaignStep.details = 'Agent has maximum campaign duration limit';
  } else {
    longCampaignStep.passed = false;
    longCampaignStep.error = 'Unclear response for long campaign';
  }
  steps.push(longCampaignStep);

  return { steps, profile };
}

/**
 * Test: Response Consistency
 * Tests for schema errors, pagination bugs, data mismatches between fields
 */
async function testResponseConsistency(agentUrl: string, options: TestOptions): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test 1: list_creatives pagination consistency
  if (profile.tools.includes('list_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'list_creatives pagination consistency',
      'list_creatives',
      async () => client.executeTask('list_creatives', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const creatives = data.creatives || [];
      const querySummary = data.query_summary;
      const pagination = data.pagination;

      const issues: string[] = [];

      // Check: total_matching vs returned vs creatives.length
      if (querySummary) {
        const totalMatching = querySummary.total_matching;
        const returned = querySummary.returned;

        if (totalMatching !== undefined && returned !== undefined) {
          if (totalMatching > 0 && returned === 0 && creatives.length === 0) {
            issues.push(`total_matching=${totalMatching} but returned=0 and creatives array empty`);
          }
          if (returned !== creatives.length) {
            issues.push(`returned=${returned} doesn't match creatives.length=${creatives.length}`);
          }
        }
      }

      // Check: pagination consistency
      if (pagination) {
        if (pagination.has_more && creatives.length === 0) {
          issues.push(`has_more=true but no creatives returned`);
        }
        if (pagination.total_pages !== undefined && pagination.current_page !== undefined) {
          if (pagination.current_page > pagination.total_pages) {
            issues.push(`current_page=${pagination.current_page} > total_pages=${pagination.total_pages}`);
          }
        }
      }

      if (issues.length > 0) {
        step.passed = false;
        step.error = `Pagination inconsistencies: ${issues.join('; ')}`;
        step.response_preview = JSON.stringify({
          issues,
          query_summary: querySummary,
          pagination,
          creatives_count: creatives.length,
        }, null, 2);
      } else {
        step.details = `Pagination consistent: ${creatives.length} creative(s)`;
        step.response_preview = JSON.stringify({
          creatives_count: creatives.length,
          total_matching: querySummary?.total_matching,
          returned: querySummary?.returned,
        }, null, 2);
      }
    } else if (result && !result.success) {
      // Schema validation error - report it
      step.passed = false;
      step.error = result.error || 'list_creatives failed';
    }
    steps.push(step);
  }

  // Test 2: get_products response consistency
  if (profile.tools.includes('get_products')) {
    const { result, step } = await runStep<TaskResult>(
      'get_products response consistency',
      'get_products',
      async () => client.executeTask('get_products', {
        brief: 'Show all available products',
        brand_manifest: { name: 'Consistency Test', url: 'https://test.example.com' },
      }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const products = data.products || [];
      const issues: string[] = [];

      for (let i = 0; i < products.length; i++) {
        const product = products[i];

        // Check: product_id is present and non-empty
        if (!product.product_id) {
          issues.push(`Product[${i}] missing product_id`);
        }

        // Check: pricing_options consistency
        if (product.pricing_options) {
          for (let j = 0; j < product.pricing_options.length; j++) {
            const po = product.pricing_options[j];
            if (!po.pricing_option_id) {
              issues.push(`Product[${i}].pricing_options[${j}] missing pricing_option_id`);
            }
            // Auction pricing should have floor_price or price_guidance
            if (po.is_fixed === false && !po.floor_price && !po.price_guidance) {
              issues.push(`Product[${i}].pricing_options[${j}] is auction but missing floor_price/price_guidance`);
            }
          }
        }

        // Check: format_ids are structured objects (not plain strings)
        if (product.format_ids) {
          for (let j = 0; j < product.format_ids.length; j++) {
            const fid = product.format_ids[j];
            if (typeof fid === 'string') {
              issues.push(`Product[${i}].format_ids[${j}] is string, should be {agent_url, id} object`);
            } else if (!fid.id) {
              issues.push(`Product[${i}].format_ids[${j}] missing id field`);
            }
          }
        }
      }

      if (issues.length > 0) {
        step.passed = false;
        step.error = `Product data inconsistencies (${issues.length} issue(s))`;
        step.response_preview = JSON.stringify({
          issues: issues.slice(0, 10), // Limit to first 10
          total_issues: issues.length,
          products_count: products.length,
        }, null, 2);
      } else {
        step.details = `Products consistent: ${products.length} product(s)`;
        step.response_preview = JSON.stringify({
          products_count: products.length,
          all_have_product_id: true,
          all_pricing_options_valid: true,
        }, null, 2);
      }
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'get_products failed';
    }
    steps.push(step);
  }

  // Test 3: list_creative_formats response consistency
  if (profile.tools.includes('list_creative_formats')) {
    const { result, step } = await runStep<TaskResult>(
      'list_creative_formats response consistency',
      'list_creative_formats',
      async () => client.executeTask('list_creative_formats', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const formatIds = data.format_ids || [];
      const formats = data.formats || [];
      const issues: string[] = [];

      // Check format_ids structure
      for (let i = 0; i < formatIds.length; i++) {
        const fid = formatIds[i];
        if (typeof fid === 'string') {
          issues.push(`format_ids[${i}] is string "${fid}", should be {agent_url, id} object`);
        } else if (fid && !fid.id) {
          issues.push(`format_ids[${i}] missing id field`);
        }
      }

      // Check formats structure if present
      for (let i = 0; i < formats.length; i++) {
        const fmt = formats[i];
        if (!fmt.format_id?.id) {
          issues.push(`formats[${i}] missing format_id.id`);
        }
      }

      if (issues.length > 0) {
        step.passed = false;
        step.error = `Format data inconsistencies (${issues.length} issue(s))`;
        step.response_preview = JSON.stringify({
          issues: issues.slice(0, 10),
          total_issues: issues.length,
          format_ids_count: formatIds.length,
          formats_count: formats.length,
        }, null, 2);
      } else {
        step.details = `Formats consistent: ${formatIds.length} format_ids, ${formats.length} formats`;
      }
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_creative_formats failed';
    }
    steps.push(step);
  }

  // Test 4: list_authorized_properties response consistency
  if (profile.tools.includes('list_authorized_properties')) {
    const { result, step } = await runStep<TaskResult>(
      'list_authorized_properties response consistency',
      'list_authorized_properties',
      async () => client.executeTask('list_authorized_properties', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const properties = data.authorized_properties || data.properties || [];
      const publisherDomains = data.publisher_domains || [];
      const issues: string[] = [];

      // Check publisher_domains are strings
      for (let i = 0; i < publisherDomains.length; i++) {
        if (typeof publisherDomains[i] !== 'string') {
          issues.push(`publisher_domains[${i}] is not a string`);
        }
      }

      // Check properties have required fields
      for (let i = 0; i < properties.length; i++) {
        const prop = properties[i];
        if (!prop.name && !prop.property_id && !prop.domain) {
          issues.push(`properties[${i}] missing identifying field (name, property_id, or domain)`);
        }
      }

      if (issues.length > 0) {
        step.passed = false;
        step.error = `Property data inconsistencies (${issues.length} issue(s))`;
        step.response_preview = JSON.stringify({
          issues: issues.slice(0, 10),
          total_issues: issues.length,
          properties_count: properties.length,
          publisher_domains_count: publisherDomains.length,
        }, null, 2);
      } else {
        step.details = `Properties consistent: ${properties.length} properties, ${publisherDomains.length} domains`;
      }
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_authorized_properties failed';
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Main entry point: Run a test scenario against an agent
 */
export async function testAgent(
  agentUrl: string,
  scenario: TestScenario,
  options: TestOptions = {}
): Promise<TestResult> {
  const startTime = Date.now();
  let steps: TestStepResult[] = [];
  let profile: AgentProfile | undefined;

  // Default dry_run to true for safety
  const effectiveOptions = {
    ...options,
    dry_run: options.dry_run !== false,
    test_session_id: options.test_session_id || `addie-test-${Date.now()}`,
  };

  logger.info({ agentUrl, scenario, options: effectiveOptions }, 'Starting agent test');

  try {
    let result: { steps: TestStepResult[]; profile?: AgentProfile };

    switch (scenario) {
      case 'health_check':
        steps = await testHealthCheck(agentUrl, effectiveOptions);
        break;
      case 'discovery':
        result = await testDiscovery(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'create_media_buy':
        result = await testCreateMediaBuy(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'full_sales_flow':
        result = await testFullSalesFlow(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'creative_sync':
        result = await testCreativeSync(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'creative_inline':
        result = await testCreativeInline(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'creative_reference':
        // TODO: Implement reference creative testing
        steps = [{
          step: 'Test reference creatives',
          passed: false,
          duration_ms: 0,
          error: 'creative_reference scenario not yet implemented',
        }];
        break;
      case 'pricing_models':
        result = await testPricingModels(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'creative_flow':
        result = await testCreativeFlow(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'signals_flow':
        result = await testSignalsFlow(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'error_handling':
        result = await testErrorHandling(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'validation':
        result = await testValidation(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'pricing_edge_cases':
        result = await testPricingEdgeCases(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'temporal_validation':
        result = await testTemporalValidation(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'behavior_analysis':
        result = await testBehaviorAnalysis(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      case 'response_consistency':
        result = await testResponseConsistency(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;
      default:
        steps = [{
          step: 'Unknown scenario',
          passed: false,
          duration_ms: 0,
          error: `Unknown test scenario: ${scenario}`,
        }];
    }
  } catch (error) {
    logger.error({ error, agentUrl, scenario }, 'Agent test failed with exception');
    steps.push({
      step: 'Test execution',
      passed: false,
      duration_ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const totalDuration = Date.now() - startTime;
  const passedCount = steps.filter(s => s.passed).length;
  const failedCount = steps.filter(s => !s.passed).length;
  const overallPassed = failedCount === 0 && passedCount > 0;

  // Generate summary
  let summary: string;
  if (overallPassed) {
    summary = `All ${passedCount} test step(s) passed in ${totalDuration}ms`;
  } else if (passedCount === 0) {
    summary = `All ${failedCount} test step(s) failed`;
  } else {
    summary = `${passedCount} passed, ${failedCount} failed out of ${steps.length} step(s)`;
  }

  const testResult: TestResult = {
    agent_url: agentUrl,
    scenario,
    overall_passed: overallPassed,
    steps,
    summary,
    total_duration_ms: totalDuration,
    tested_at: new Date().toISOString(),
    agent_profile: profile,
    dry_run: effectiveOptions.dry_run,
  };

  logger.info({ agentUrl, scenario, overallPassed, passedCount, failedCount, totalDuration }, 'Agent test completed');

  return testResult;
}

/**
 * Format test results for display in Slack/chat
 */
export function formatTestResults(result: TestResult): string {
  const statusEmoji = result.overall_passed ? '✅' : '❌';
  let output = `## ${statusEmoji} Agent Test Results\n\n`;
  output += `**Agent:** ${result.agent_url}\n`;
  output += `**Scenario:** ${result.scenario}\n`;
  output += `**Duration:** ${result.total_duration_ms}ms\n`;
  output += `**Mode:** ${result.dry_run ? '🧪 Dry Run' : '🔴 Live'}\n`;
  output += `**Result:** ${result.summary}\n\n`;

  // Show agent profile if discovered
  if (result.agent_profile) {
    output += `### Agent Capabilities\n`;
    output += `- **Name:** ${result.agent_profile.name}\n`;
    output += `- **Tools:** ${result.agent_profile.tools.length}\n`;
    if (result.agent_profile.channels?.length) {
      output += `- **Channels:** ${result.agent_profile.channels.join(', ')}\n`;
    }
    if (result.agent_profile.pricing_models?.length) {
      output += `- **Pricing Models:** ${result.agent_profile.pricing_models.join(', ')}\n`;
    }
    output += '\n';
  }

  output += `### Test Steps\n\n`;

  for (const step of result.steps) {
    const stepEmoji = step.passed ? '✅' : '❌';
    output += `${stepEmoji} **${step.step}**`;
    if (step.task) {
      output += ` (\`${step.task}\`)`;
    }
    output += ` - ${step.duration_ms}ms\n`;

    if (step.details) {
      output += `   ${step.details}\n`;
    }

    if (step.error) {
      output += `   ⚠️ Error: ${step.error}\n`;
    }

    if (step.response_preview && !step.error) {
      output += `   \`\`\`json\n   ${step.response_preview.split('\n').join('\n   ')}\n   \`\`\`\n`;
    }

    output += '\n';
  }

  if (!result.overall_passed) {
    output += `---\n\n`;
    output += `💡 **Need help?** Ask me about specific errors or check the [AdCP documentation](https://adcontextprotocol.org/docs).\n`;
  }

  return output;
}
