import {
  ReadOnlyToolLoopBoundaryError,
  type ReadOnlyToolLoopResult,
  type ReadOnlyToolLoopReason,
} from './read-only-tool-loop.js';
import type { ModelProviderId } from './model-provider.js';

export type ReadOnlyToolLoopFailureReason = ReadOnlyToolLoopReason | 'timeout' | 'provider_error';

export interface ReadOnlyToolLoopFailureReportInput {
  requestedProvider: ModelProviderId;
  requestedModel: string;
  sourceSha256: string;
  gitCommit: string;
  gitDirty: boolean;
  docsCorpusSha256: string;
  invocationSha256: ReadonlyArray<string>;
  latencyMs: number;
  error: unknown;
  timedOut: boolean;
}

export interface ReadOnlyToolLoopCompatibilityFailureReportInput {
  requestedProvider: ModelProviderId;
  requestedModel: string;
  sourceSha256: string;
  gitCommit: string;
  gitDirty: boolean;
  docsCorpusSha256: string;
  invocationSha256: ReadonlyArray<string>;
  latencyMs: number;
  result: ReadOnlyToolLoopResult;
}

export function buildReadOnlyToolLoopFailureReport(input: ReadOnlyToolLoopFailureReportInput) {
  const reason: ReadOnlyToolLoopFailureReason = input.timedOut
    ? 'timeout'
    : input.error instanceof ReadOnlyToolLoopBoundaryError
      ? input.error.reason
      : 'provider_error';
  return Object.freeze({
    schema_version: 1,
    status: reason === 'provider_error' || reason === 'timeout' ? 'error' : 'blocked',
    reason,
    requested_provider: input.requestedProvider,
    requested_model: input.requestedModel,
    source_sha256: input.sourceSha256,
    git_commit: input.gitCommit,
    git_dirty: input.gitDirty,
    docs_corpus_sha256: input.docsCorpusSha256,
    usage_known: false,
    max_dispatches: 2,
    dispatch_count: input.invocationSha256.length,
    invocation_sha256: Object.freeze([...input.invocationSha256]),
    latency_ms: input.latencyMs,
  });
}

export function buildReadOnlyToolLoopCompatibilityFailureReport(
  input: ReadOnlyToolLoopCompatibilityFailureReportInput,
) {
  return Object.freeze({
    schema_version: 1,
    status: 'failed',
    reason: 'compatibility_failed',
    requested_provider: input.requestedProvider,
    requested_model: input.requestedModel,
    source_sha256: input.sourceSha256,
    git_commit: input.gitCommit,
    git_dirty: input.gitDirty,
    docs_corpus_sha256: input.docsCorpusSha256,
    usage_known: true,
    max_dispatches: 2,
    dispatch_count: input.invocationSha256.length,
    invocation_sha256: Object.freeze([...input.invocationSha256]),
    provider: input.result.response.provider,
    model: input.result.response.model,
    finish_reason: input.result.response.finishReason,
    iterations: input.result.iterations,
    tool_executions: input.result.toolExecutions,
    usage: input.result.usage,
    latency_ms: input.latencyMs,
  });
}
