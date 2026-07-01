/**
 * RFC-drafting grader.
 *
 * Scores Addie's behavior when a member asks her to draft an RFC / GitHub
 * issue against the AdCP spec. The failure mode this grader is designed to
 * catch: Addie drafts the issue using the caller's framing without verifying
 * the gap against the spec, then a second instance (different surface, same
 * agent) does the verification work and contradicts the first.
 *
 * Three dimensions are scored independently — a single boolean per scenario
 * masks which of these moved.
 *
 *   1. Router selection — did the router pick `knowledge` (so search_docs is
 *      reachable)? This is the primary upstream cause of the failure.
 *   2. Tool use — did Sonnet actually call search_docs / get_schema before
 *      emitting a draft? Reachability is necessary but not sufficient.
 *   3. Response substance — did the response cite real spec fields, push
 *      back on the premise when warranted, and avoid emitting a fully-formed
 *      draft block before any verification turn?
 *
 * Used by replay-prod-scenarios.ts for scenarios tagged `category: 'rfc'`.
 * Lives alongside shape-grader.ts and stays dependency-free.
 */

export interface RfcExpectations {
  /** Tool sets the router MUST include for this scenario. Subset match. */
  expectedToolSets?: string[];
  /** Tool names that MUST appear in tool_use blocks before any text response. */
  expectedToolCalls?: string[];
  /** Schema fields/concepts that should appear verbatim in the response text. */
  expectedFieldCitations?: string[];
  /**
   * If true, the caller's premise contains a factual error and Addie should
   * push back rather than draft. Detected by absence of a draft_github_issue
   * tool_use AND presence of corrective language.
   */
  shouldRefusePremise?: boolean;
}

export interface RfcRunObservations {
  /** Tool sets selected by the router. */
  routerToolSets: string[];
  /** Tool names called by Sonnet across all turns, in order. */
  toolCalls: string[];
  /** Final text response (last assistant turn after all tool loops). */
  finalText: string;
  /** Whether draft_github_issue was called at any point. */
  draftEmitted: boolean;
}

export interface RfcGrade {
  routerOk: boolean;
  toolCallsOk: boolean;
  citationsOk: boolean;
  premiseOk: boolean;
  passed: boolean;
  failures: string[];
}

const PUSHBACK_MARKERS = [
  'already',
  "doesn't exist",
  'does not exist',
  'no such',
  'not in the spec',
  'already in the spec',
  'already covered',
  'already addressed',
  'already supported',
  'factual error',
  'premise',
  'reframe',
  // softer-but-clear pushback that still signals "you're partly wrong"
  'overlaps',
  'overlap with',
  'most of this',
  'most of what',
  'most of the',
  'partly addressed',
  'partly covered',
  'partially covered',
  'narrower',
  // direct correction language
  "isn't a",
  'is not a',
  'no trusted_match',
  'no direct_sold_signals',
];

export function gradeRfcRun(
  expect: RfcExpectations,
  obs: RfcRunObservations,
): RfcGrade {
  const failures: string[] = [];

  // 1. Router tool sets — every expected set must be present.
  let routerOk = true;
  if (expect.expectedToolSets && expect.expectedToolSets.length > 0) {
    const missing = expect.expectedToolSets.filter(
      (s) => !obs.routerToolSets.includes(s),
    );
    if (missing.length > 0) {
      routerOk = false;
      failures.push(
        `router missing expected tool sets: [${missing.join(', ')}] (got [${obs.routerToolSets.join(', ')}])`,
      );
    }
  }

  // 2. Tool calls — every expected tool must appear in the call list.
  let toolCallsOk = true;
  if (expect.expectedToolCalls && expect.expectedToolCalls.length > 0) {
    const missingCalls = expect.expectedToolCalls.filter(
      (t) => !obs.toolCalls.includes(t),
    );
    if (missingCalls.length > 0) {
      toolCallsOk = false;
      failures.push(
        `expected tool calls not made: [${missingCalls.join(', ')}] (called [${obs.toolCalls.join(', ')}])`,
      );
    }
  }

  // 3. Field citations — at least one expected field/concept must appear.
  let citationsOk = true;
  if (expect.expectedFieldCitations && expect.expectedFieldCitations.length > 0) {
    const text = obs.finalText.toLowerCase();
    const found = expect.expectedFieldCitations.filter((f) =>
      text.includes(f.toLowerCase()),
    );
    if (found.length === 0) {
      citationsOk = false;
      failures.push(
        `no expected field citation in response (looked for: [${expect.expectedFieldCitations.join(', ')}])`,
      );
    }
  }

  // 4. Premise pushback — when the caller's premise is factually wrong.
  let premiseOk = true;
  if (expect.shouldRefusePremise) {
    const text = obs.finalText.toLowerCase();
    const pushedBack = PUSHBACK_MARKERS.some((m) => text.includes(m));
    if (obs.draftEmitted && !pushedBack) {
      premiseOk = false;
      failures.push(
        'emitted draft without pushing back on factually-wrong premise',
      );
    } else if (!pushedBack) {
      premiseOk = false;
      failures.push(
        'no pushback language in response (premise contains factual error)',
      );
    }
  }

  return {
    routerOk,
    toolCallsOk,
    citationsOk,
    premiseOk,
    passed: routerOk && toolCallsOk && citationsOk && premiseOk,
    failures,
  };
}

/**
 * Stub tool definitions for tool-use measurement. The runner gives Sonnet
 * these definitions so it CAN call search_docs / get_schema — what we're
 * measuring is whether it does. Stubs return canned data so the agent can
 * make progress past the tool turn. Keep the surface minimal: anything
 * Addie wouldn't have offered in this conversation shouldn't appear here.
 */
export const RFC_STUB_TOOLS = [
  {
    name: 'search_docs',
    description:
      'Search AdCP documentation. Returns top-matching doc snippets for the query. Use before answering schema/protocol questions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_doc',
    description:
      'Get the full content of a specific documentation page. Use this after search_docs to read a document in detail — search_docs returns summaries only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        doc_id: { type: 'string', description: 'Doc ID from search_docs results' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'get_schema',
    description:
      'Fetch a specific AdCP schema by name (e.g. "get_adcp_capabilities", "create_media_buy"). Returns full JSON Schema definition.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Schema name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'validate_json',
    description: 'Validate a JSON object against an AdCP schema.',
    input_schema: {
      type: 'object' as const,
      properties: {
        schema: { type: 'string' },
        instance: { type: 'object' },
      },
      required: ['schema', 'instance'],
    },
  },
  {
    name: 'draft_github_issue',
    description:
      'Draft a pre-filled GitHub issue link the user can click. Use only after verifying the gap is real via search_docs/get_schema.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['repo', 'title', 'body'],
    },
  },
] as const;

/**
 * Canned tool results for the stub tools. The grader cares about whether
 * a tool was *called*, not what it returned — but the model needs a
 * non-empty result to continue the turn loop without errors.
 */
export function stubToolResult(toolName: string, input: unknown): string {
  const query = ((input as { query?: string; doc_id?: string })?.query ?? '').toLowerCase();
  const docId = (input as { doc_id?: string })?.doc_id ?? '';

  if (toolName === 'search_docs') {
    // build_creative scenario: search summary deliberately omits the
    // atomicity rule so the model must call get_doc to confirm. Mirrors prod
    // behavior — search_docs returns summaries with `[Use get_doc for full
    // content]` hints; the authoritative sentence often lives only in the
    // full doc.
    if (query.includes('build_creative') || query.includes('creative_manifests') || query.includes('multi-format') || query.includes('partial fail')) {
      return JSON.stringify({
        results: [
          {
            id: 'creative/task-reference/build_creative',
            title: 'build_creative',
            snippet:
              '`build_creative` accepts `target_format_id` for single-format calls or `target_format_ids[]` for multi-format. Multi-format returns `creative_manifests[]`. Each manifest carries its own `format_id`. [Use get_doc for full content]',
          },
          {
            id: 'building/by-layer/L3/error-handling',
            title: 'Error Handling',
            snippet:
              'Error objects follow `error.json` with `code`, `message`, `recovery`, `field`, `suggestion`. Level 2 compliance adds recovery classification for agent self-correction. [Use get_doc for full content]',
          },
        ],
      });
    }
    return JSON.stringify({
      results: [
        {
          id: 'reference/data-models/product',
          title: 'Product schema reference',
          snippet:
            'Products carry pricing_options. create_media_buy requires a pricing_option_id. Brief mode + filters drive discovery; buying_mode: refine iterates with a typed change array. account parameter on get_products returns rate-card-scoped pricing.',
        },
      ],
    });
  }
  if (toolName === 'get_doc') {
    if (docId.includes('build_creative')) {
      return JSON.stringify({
        id: 'creative/task-reference/build_creative',
        title: 'build_creative',
        content:
          'Multi-format response semantics\n\nWhen the request uses `target_format_ids[]`, the response carries `creative_manifests[]` — one manifest per requested format, in request order. Multi-format requests are atomic — if any format fails (e.g., `FORMAT_NOT_SUPPORTED`), the entire request fails with an error response. There is no per-manifest `errors[]` field; partial success is not allowed.\n\nTo refine a single format from a multi-format build, call `build_creative` again with `target_format_id` (singular) and pass back that format\'s manifest.',
      });
    }
    return JSON.stringify({ id: docId, content: '(stub content)' });
  }
  if (toolName === 'get_schema') {
    return JSON.stringify({
      name: 'get_adcp_capabilities',
      top_level_keys: [
        'adcp',
        'supported_protocols',
        'account',
        'media_buy',
        'signals',
        'governance',
        'sponsored_intelligence',
        'brand',
        'creative',
        'request_signing',
        'webhook_signing',
        'identity',
        'compliance_testing',
        'specialisms',
      ],
      note: 'signals only declares data_provider_domains and a features map; no trusted_match key.',
    });
  }
  if (toolName === 'validate_json') {
    return JSON.stringify({ valid: true });
  }
  if (toolName === 'draft_github_issue') {
    return JSON.stringify({ url: 'https://github.com/adcontextprotocol/adcp/issues/new?...' });
  }
  return JSON.stringify({ ok: true });
}
