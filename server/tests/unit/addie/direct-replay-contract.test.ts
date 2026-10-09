import { describe, expect, it, vi } from 'vitest';
import {
  AddieClaudeClient,
  consumeDirectReplayContract,
  type DirectReplayContract,
  type DirectReplayContractFacts,
  type RequestTools,
} from '../../../src/addie/claude-client.js';
import { OFFICIAL_DOCS_ALLOWED_TOOLS } from '../../../src/addie/jobs/shadow-replay-cohort.js';
import { KNOWLEDGE_TOOLS } from '../../../src/addie/mcp/knowledge-search.js';
import type { ModelRequest } from '../../../src/addie/model-providers/model-provider.js';
import type { AddieTool } from '../../../src/addie/types.js';

function tool(name: string, description = `${name} description`): AddieTool {
  return {
    name,
    description,
    replaySafety: 'pure_local',
    input_schema: { type: 'object', properties: {} },
  };
}

function facts(names: readonly string[], overrides: Partial<DirectReplayContractFacts> = {}): DirectReplayContractFacts {
  return {
    surface: 'slack_channel',
    isAdmin: false,
    threadId: 'thread-1',
    channelPrivacy: 'public',
    replayPrincipal: 'U_REPLAY',
    caseId: 'case-1',
    requestId: 'request-1',
    selectedToolSetNames: ['knowledge'],
    selectedToolNames: names,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function mintContract(
  client: AddieClaudeClient,
  local: RequestTools,
  contractFacts: DirectReplayContractFacts,
  options: {
    disableServerTools: true;
    selectedToolSetNames: readonly string[];
    allowedToolNames?: readonly string[];
  },
): DirectReplayContract {
  let contract: DirectReplayContract | undefined;
  // This is the real private first-invocation assembly, not a test factory.
  // prepareMessageInvocation stops before SDK dispatch and invokes no handler.
  client.prepareMessageInvocation('authenticated Slack request', undefined, local, undefined, {
    ...options,
    directReplayContractFacts: contractFacts,
    onDirectReplayContract: (issued) => { contract = issued; },
  });
  if (!contract) throw new Error('fixture failed to mint a production-assembled contract');
  return contract;
}

function contractFixture(): {
  client: AddieClaudeClient;
  local: RequestTools;
  localDefinition: AddieTool;
  localHandler: ReturnType<typeof vi.fn>;
  contract: DirectReplayContract;
  contractFacts: DirectReplayContractFacts;
  options: {
    disableServerTools: true;
    selectedToolSetNames: string[];
    allowedToolNames: string[];
  };
} {
  const client = new AddieClaudeClient('unused');
  client.registerTool(tool('global_only'), vi.fn(async () => 'global'));
  const localDefinition = tool('local_only');
  const localHandler = vi.fn(async () => 'local');
  const local: RequestTools = {
    tools: [localDefinition, tool('second_local')],
    handlers: new Map([
      ['local_only', localHandler],
      ['second_local', vi.fn(async () => 'second')],
    ]),
  };
  const contractFacts = facts(['global_only', 'local_only', 'second_local']);
  const options = {
    disableServerTools: true,
    selectedToolSetNames: ['knowledge'],
    allowedToolNames: ['global_only', 'local_only', 'second_local'],
  } satisfies {
    disableServerTools: true;
    selectedToolSetNames: string[];
    allowedToolNames: string[];
  };
  const contract = mintContract(client, local, contractFacts, options);
  return { client, local, localDefinition, localHandler, contract, contractFacts, options };
}

function capturingClient(): { client: AddieClaudeClient; prepared: ModelRequest[] } {
  const prepared: ModelRequest[] = [];
  const provider = {
    id: 'anthropic',
    capabilities: {
      streaming: false,
      structuredOutput: true,
      reasoning: true,
      reasoningEfforts: ['provider_default', 'none', 'low', 'medium', 'high'],
      customTools: true,
      providerWebSearch: false,
      imageInput: false,
      documentInput: false,
    },
    prepare: vi.fn((request: ModelRequest) => {
      prepared.push(request);
      return {
        provider: 'anthropic',
        model: request.model,
        capabilities: provider.capabilities,
        providerRequest: request,
      };
    }),
    respond: vi.fn(),
  };
  return {
    client: new AddieClaudeClient('unused', undefined, undefined, { provider: provider as never }),
    prepared,
  };
}

describe('direct replay contract', () => {
  it('preserves the live direct request-local winner while remaining dormant', () => {
    const { client, prepared } = capturingClient();
    const globalHandler = vi.fn(async () => 'global handler');
    const localHandler = vi.fn(async () => 'local handler');
    client.registerTool(tool('same_name', 'global definition'), globalHandler);
    const local: RequestTools = {
      tools: [tool('same_name', 'request-local definition'), tool('local_only')],
      handlers: new Map([['same_name', localHandler], ['local_only', vi.fn(async () => 'local')]]),
    };
    const options = {
      disableServerTools: true,
      selectedToolSetNames: ['knowledge'],
      allowedToolNames: ['same_name', 'local_only'],
    } as const;
    const before = client.prepareMessageInvocation('live direct Slack message', undefined, local, undefined, options);
    const contract = mintContract(client, local, facts(['same_name', 'local_only']), options);
    const after = client.prepareMessageInvocation('live direct Slack message', undefined, local, undefined, options);

    expect(contract).toBeDefined();
    expect(before.tool_schemas).toEqual(after.tool_schemas);
    expect(after.tool_schemas.map(({ name }) => name)).toEqual(['same_name', 'local_only']);
    expect(prepared).toHaveLength(3);
    expect(prepared.every((request) => request.tools.map(({ name }) => name).join(',') === 'same_name,local_only')).toBe(true);
    expect(prepared[0]?.tools[0]).toMatchObject({ name: 'same_name', description: 'request-local definition' });
    expect(consumeDirectReplayContract(contract)).toEqual({ admitted: true });
    // The assembly/capability path is intentionally non-dispatching.
    expect(globalHandler).not.toHaveBeenCalled();
    expect(localHandler).not.toHaveBeenCalled();
  });

  it('admits the exact official-docs two-tool global profile only', () => {
    const client = new AddieClaudeClient('unused');
    for (const name of OFFICIAL_DOCS_ALLOWED_TOOLS) {
      const definition = KNOWLEDGE_TOOLS.find((candidate) => candidate.name === name);
      if (!definition) throw new Error(`Missing ${name}`);
      client.registerTool(definition, vi.fn(async () => 'not dispatched'));
    }
    const contract = mintContract(client, { tools: [], handlers: new Map() }, facts(OFFICIAL_DOCS_ALLOWED_TOOLS), {
      disableServerTools: true,
      selectedToolSetNames: ['knowledge'],
      allowedToolNames: OFFICIAL_DOCS_ALLOWED_TOOLS,
    });

    expect(contract).toBeDefined();
    expect(consumeDirectReplayContract(contract)).toEqual({ admitted: true });
  });

  it.each([
    ['missing definitions', (fixture: ReturnType<typeof contractFixture>) => fixture.local.tools.pop()],
    ['extra definitions', (fixture: ReturnType<typeof contractFixture>) => fixture.local.tools.push(tool('extra'))],
    ['reordered definitions', (fixture: ReturnType<typeof contractFixture>) => fixture.local.tools.reverse()],
    ['duplicate definitions', (fixture: ReturnType<typeof contractFixture>) => fixture.local.tools.push(fixture.localDefinition)],
    ['mutated definitions', (fixture: ReturnType<typeof contractFixture>) => { fixture.localDefinition.description = 'mutated'; }],
    ['swapped handlers', (fixture: ReturnType<typeof contractFixture>) => fixture.local.handlers.set('local_only', vi.fn(async () => 'swapped'))],
    ['missing handlers', (fixture: ReturnType<typeof contractFixture>) => fixture.local.handlers.delete('local_only')],
    ['restamped facts', (fixture: ReturnType<typeof contractFixture>) => { fixture.contractFacts.caseId = 'case-2'; }],
    ['restamped policy', (fixture: ReturnType<typeof contractFixture>) => fixture.options.selectedToolSetNames.push('admin')],
  ] as const)('fails closed for post-mint %s', (_name, mutate) => {
    const fixture = contractFixture();
    mutate(fixture);
    expect(consumeDirectReplayContract(fixture.contract)).toEqual({ admitted: false, reason: 'assembly_drift' });
  });

  it('rejects accessor and Proxy definitions before any capability is minted', () => {
    const client = new AddieClaudeClient('unused');
    const accessor = tool('accessor');
    Object.defineProperty(accessor, 'description', {
      enumerable: true,
      get: () => 'must not be accepted',
    });
    const accessorTools: RequestTools = {
      tools: [accessor],
      handlers: new Map([['accessor', vi.fn(async () => 'never')]]),
    };
    const proxied = new Proxy(tool('proxied'), {});
    const proxyTools: RequestTools = {
      tools: [proxied],
      handlers: new Map([['proxied', vi.fn(async () => 'never')]]),
    };
    const options = { disableServerTools: true, selectedToolSetNames: ['knowledge'] } as const;

    let issued: DirectReplayContract | undefined;
    client.prepareMessageInvocation('accessor', undefined, accessorTools, undefined, {
      ...options,
      directReplayContractFacts: facts(['accessor']),
      onDirectReplayContract: (contract) => { issued = contract; },
    });
    expect(issued).toBeUndefined();
    client.prepareMessageInvocation('proxy', undefined, proxyTools, undefined, {
      ...options,
      directReplayContractFacts: facts(['proxied']),
      onDirectReplayContract: (contract) => { issued = contract; },
    });
    expect(issued).toBeUndefined();
  });

  it('treats visible brands, prototypes, hashes, and serialized copies as evidence only', () => {
    const { contract } = contractFixture();
    class CopiedProductionLookingContract {}
    const copied = Object.assign(Object.create(CopiedProductionLookingContract.prototype), contract);
    const serialized = JSON.parse(JSON.stringify(contract));
    const sameHashes = { audit: { ...contract.audit } };

    expect(consumeDirectReplayContract(copied)).toEqual({ admitted: false, reason: 'unknown_contract' });
    expect(consumeDirectReplayContract(serialized)).toEqual({ admitted: false, reason: 'unknown_contract' });
    expect(consumeDirectReplayContract(sameHashes)).toEqual({ admitted: false, reason: 'unknown_contract' });
  });

  it('enforces expiry, abort, and one-use consumption without dispatching a provider, tool, budget, credential, mutation, or output', () => {
    const expired = contractFixture();
    expect(consumeDirectReplayContract(expired.contract, expired.contractFacts.expiresAt)).toEqual({ admitted: false, reason: 'expired' });
    expect(consumeDirectReplayContract(expired.contract)).toEqual({ admitted: false, reason: 'already_consumed' });

    const controller = new AbortController();
    const aborted = contractFixture();
    const abortable = mintContract(aborted.client, aborted.local, facts(['global_only', 'local_only', 'second_local'], {
      abortSignal: controller.signal,
    }), {
      disableServerTools: true,
      selectedToolSetNames: ['knowledge'],
      allowedToolNames: ['global_only', 'local_only', 'second_local'],
    });
    controller.abort();
    expect(consumeDirectReplayContract(abortable)).toEqual({ admitted: false, reason: 'aborted' });

    const once = contractFixture();
    expect(consumeDirectReplayContract(once.contract)).toEqual({ admitted: true });
    expect(consumeDirectReplayContract(once.contract)).toEqual({ admitted: false, reason: 'already_consumed' });
    expect(once.localHandler).not.toHaveBeenCalled();
  });
});
