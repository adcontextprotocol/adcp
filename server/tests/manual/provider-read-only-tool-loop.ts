import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  getDocsCorpusFingerprint,
  initializeDocsIndex,
  isDocsIndexReady,
} from '../../src/addie/mcp/docs-indexer.js';
import {
  GOOGLE_ROUTER_MODEL,
  GoogleGenerateContentProvider,
} from '../../src/addie/model-providers/google-generate-content-provider.js';
import { executeReadOnlyToolLoop } from '../../src/addie/model-providers/read-only-tool-loop.js';
import {
  buildReadOnlyToolLoopCompatibilityFailureReport,
  buildReadOnlyToolLoopFailureReport,
} from '../../src/addie/model-providers/read-only-tool-loop-report.js';
import { createOfficialDocsReadOnlyToolBoundary } from '../../src/addie/jobs/official-docs-read-only-tools.js';

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) throw new Error('GEMINI_API_KEY is required');

await initializeDocsIndex();
if (!isDocsIndexReady()) throw new Error('Official docs index is not ready');

const invocationHashes: string[] = [];
const startedAt = Date.now();
const sourceHash = createHash('sha256');
for (const sourceUrl of [
  import.meta.url,
  new URL('../../src/addie/model-providers/google-generate-content-provider.ts', import.meta.url).href,
  new URL('../../src/addie/model-providers/read-only-tool-loop.ts', import.meta.url).href,
  new URL('../../src/addie/model-providers/read-only-tool-loop-report.ts', import.meta.url).href,
  new URL('../../src/addie/jobs/official-docs-read-only-tools.ts', import.meta.url).href,
]) {
  sourceHash.update(readFileSync(fileURLToPath(sourceUrl)));
  sourceHash.update('\0');
}
const sourceSha256 = sourceHash.digest('hex');
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const gitDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
const docsCorpusSha256 = getDocsCorpusFingerprint();
const controller = new AbortController();
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  controller.abort(new Error('provider_read_only_tool_loop_timeout'));
}, 60_000);

try {
  const boundary = createOfficialDocsReadOnlyToolBoundary();
  const result = await executeReadOnlyToolLoop(
      new GoogleGenerateContentProvider(apiKey),
      {
        model: GOOGLE_ROUTER_MODEL,
        system: [{
          text: 'This is a synthetic compatibility check. Call search_docs exactly once, do not call get_doc, then answer only from the search result.',
        }],
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'According to the official documentation, what is the current stable AdCP release line?' }],
        }],
        tools: [],
        reasoning: { effort: 'low' },
        maxOutputTokens: 300,
        requestMetadata: { purpose: 'provider_read_only_tool_loop_canary_v1' },
      },
      boundary.tools,
      {
        signal: controller.signal,
        authorizeToolExecution: boundary.authorizeToolExecution,
        beforeDispatch: ({ providerRequest }) => {
          invocationHashes.push(createHash('sha256').update(JSON.stringify(providerRequest), 'utf8').digest('hex'));
        },
      },
    );

  const compatible = result.response.finishReason === 'stop'
    && result.toolExecutions.length === 1
    && result.toolExecutions[0].toolName === 'search_docs'
    && result.toolExecutions[0].disposition === 'succeeded';

  if (!compatible) {
    process.stdout.write(`${JSON.stringify(buildReadOnlyToolLoopCompatibilityFailureReport({
      requestedProvider: 'google',
      requestedModel: GOOGLE_ROUTER_MODEL,
      sourceSha256,
      gitCommit,
      gitDirty,
      docsCorpusSha256,
      invocationSha256: invocationHashes,
      latencyMs: Date.now() - startedAt,
      result,
    }), null, 2)}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    status: 'succeeded',
    requested_provider: 'google',
    requested_model: GOOGLE_ROUTER_MODEL,
    source_sha256: sourceSha256,
    git_commit: gitCommit,
    git_dirty: gitDirty,
    docs_corpus_sha256: docsCorpusSha256,
    usage_known: true,
    max_dispatches: 2,
    dispatch_count: invocationHashes.length,
    provider: result.response.provider,
    model: result.response.model,
    finish_reason: result.response.finishReason,
    iterations: result.iterations,
    invocation_sha256: invocationHashes,
    tool_executions: result.toolExecutions,
    usage: result.usage,
    latency_ms: Date.now() - startedAt,
    output_bytes: Buffer.byteLength(result.text, 'utf8'),
    output_sha256: createHash('sha256').update(result.text, 'utf8').digest('hex'),
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(buildReadOnlyToolLoopFailureReport({
    requestedProvider: 'google',
    requestedModel: GOOGLE_ROUTER_MODEL,
    sourceSha256,
    gitCommit,
    gitDirty,
    docsCorpusSha256,
    invocationSha256: invocationHashes,
    latencyMs: Date.now() - startedAt,
    error,
    timedOut,
  }), null, 2)}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
