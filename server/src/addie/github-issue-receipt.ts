import type { ToolHandlerResult } from './tool-result-contract.js';
import type { ToolExecution } from './model-providers/tool-orchestration.js';

const GITHUB_ISSUES_ORIGIN = 'https://github.com';
const GITHUB_ISSUES_PATH = '/adcontextprotocol/adcp/issues/';

export const GITHUB_ISSUE_NOT_CONFIRMED_OUTCOME =
  'GitHub issue creation was not confirmed; no issue was reported as created. Please retry the request if needed.';

export interface GithubIssueCreationReceipt {
  readonly toolName: 'create_github_issue';
  readonly issueNumber: number;
  readonly issueUrl: string;
}

/**
 * A production write needs an application-owned action signal. Ordinary chat
 * prose may ask for a draft, but it never authorizes dispatch on its own.
 * Isolated executions have no live external effect and retain their existing
 * evaluation/replay behavior.
 */
export function mayDispatchGithubIssueCreation(
  creationRequested: boolean,
  executionMode: 'production' | 'evaluation' | 'replay' | 'shadow',
): boolean {
  return executionMode !== 'production' || creationRequested;
}

/** Application-recorded conversation data; model text is intentionally absent. */
export interface GithubIssueCreationIntentContext {
  readonly user: string;
  readonly toolCalls?: readonly {
    readonly name: string;
    readonly is_error?: boolean;
  }[] | null;
}

interface GithubIssueCreationResult {
  readonly kind: 'github_issue_creation';
  readonly status: 'ok';
  readonly receipt: GithubIssueCreationReceipt;
  readonly model_context: string;
  readonly user_summary: string;
}

function canonicalReceipt(input: { issueNumber: number; issueUrl: string }): GithubIssueCreationReceipt | null {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) return null;
  const canonicalUrl = `${GITHUB_ISSUES_ORIGIN}${GITHUB_ISSUES_PATH}${input.issueNumber}`;
  // URL parsing alone would normalize credential-bearing/default-port forms
  // while preserving the caller's raw spelling for terminal rendering. Store
  // and render only the one canonical serialization accepted by the durable
  // reservation predicate.
  if (input.issueUrl !== canonicalUrl) return null;
  try {
    const url = new URL(input.issueUrl);
    if (
      url.origin !== GITHUB_ISSUES_ORIGIN
      || url.pathname !== `${GITHUB_ISSUES_PATH}${input.issueNumber}`
      || url.search !== ''
      || url.hash !== ''
    ) return null;
  } catch {
    return null;
  }
  return Object.freeze({
    toolName: 'create_github_issue',
    issueNumber: input.issueNumber,
    issueUrl: input.issueUrl,
  });
}

/** Revalidate a receipt read from durable request-local checkpoint data. */
export function githubIssueReceiptFromStoredValue(value: unknown): GithubIssueCreationReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<GithubIssueCreationReceipt>;
  if (candidate.toolName !== 'create_github_issue') return null;
  return canonicalReceipt({
    issueNumber: candidate.issueNumber as number,
    issueUrl: candidate.issueUrl as string,
  });
}

/** Constructed only by the application handler after GitHub returns an issue. */
export function githubIssueCreatedResult(input: {
  issueNumber: number;
  issueUrl: string;
}): ToolHandlerResult {
  const receipt = canonicalReceipt(input);
  if (!receipt) throw new Error('GitHub returned an invalid issue creation receipt');
  const result: GithubIssueCreationResult = {
    kind: 'github_issue_creation',
    status: 'ok',
    receipt,
    // The model may discuss the result, but terminal delivery is rendered from
    // `receipt`; it never supplies a success claim or an identifier.
    model_context: 'GitHub issue creation completed. The application will render the confirmed issue receipt.',
    user_summary: 'GitHub issue creation completed.',
  };
  return result;
}

/** Reject strings, malformed structured results, and lookalike data. */
export function githubIssueReceiptFromHandlerResult(result: ToolHandlerResult): GithubIssueCreationReceipt | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const candidate = result as Partial<GithubIssueCreationResult>;
  if (candidate.kind !== 'github_issue_creation' || candidate.status !== 'ok') return null;
  return githubIssueReceiptFromStoredValue(candidate.receipt);
}

function receiptLine(receipt: GithubIssueCreationReceipt): string {
  return `- [#${receipt.issueNumber}](${receipt.issueUrl})`;
}

export function renderGithubIssueCreationReceipt(receipt: GithubIssueCreationReceipt): string {
  return `GitHub issue created:\n${receiptLine(receipt)}`;
}

/**
 * The terminal GitHub outcome is application-rendered. The input executions
 * are request-local, so a receipt reconstructed from a prior turn cannot be
 * used here. Any attempted but unreceipted creation is deterministic failure.
 */
export function renderGithubIssueCreationOutcome(input: {
  creationRequested: boolean;
  executions: readonly ToolExecution[];
}): { text: string | null; reason: 'github_issue_not_confirmed' | null } {
  const attempts = input.executions.filter((execution) => execution.tool_name === 'create_github_issue');
  if (!input.creationRequested && attempts.length === 0) return { text: null, reason: null };

  const receipts = attempts.flatMap((execution) => (
    !execution.is_error && execution.github_issue_receipt ? [execution.github_issue_receipt] : []
  ));
  if (attempts.length === 0 || receipts.length !== attempts.length) {
    return { text: GITHUB_ISSUE_NOT_CONFIRMED_OUTCOME, reason: 'github_issue_not_confirmed' };
  }

  const distinct = [...new Map(receipts.map((receipt) => [
    `${receipt.issueNumber}\0${receipt.issueUrl}`,
    receipt,
  ])).values()];
  return {
    text: distinct.length === 1
      ? renderGithubIssueCreationReceipt(distinct[0]!)
      : `GitHub issues created:\n${distinct.map(receiptLine).join('\n')}`,
    reason: null,
  };
}

function hasPendingGithubIssueDraft(context: readonly GithubIssueCreationIntentContext[] | undefined): boolean {
  const priorAssistantMessage = context?.at(-1);
  // A draft is application-recorded tool metadata, not text saying that a
  // draft exists. Only the immediately preceding completed assistant turn can
  // establish the confirmation context.
  return priorAssistantMessage?.user === 'Addie'
    && priorAssistantMessage.toolCalls?.some((call) => (
      call.name === 'draft_github_issue' && call.is_error !== true
    )) === true;
}

function isStandaloneCreationConfirmation(message: string): boolean {
  const normalized = message.trim().toLowerCase().replace(/[,.!]/g, ' ').replace(/\s+/g, ' ').trim();
  return new Set([
    'yes', 'yep', 'yeah', 'sure', 'ok', 'okay',
    'please do', 'go ahead', 'do it', 'create it', 'file it', 'open it',
    'yes go ahead', 'yes please do',
  ]).has(normalized);
}

/**
 * Determines whether this user turn asks to create an issue. This boundary is
 * deliberately about request routing only: it cannot authorize a success,
 * number, or URL. Those always come from a same-turn typed tool receipt.
 *
 * A compact confirmation is accepted only after a server-recorded successful
 * draft in the immediately preceding assistant turn. This supports the normal
 * draft → confirm workflow without reading model-authored draft prose.
 */
export function isGithubIssueCreationRequested(
  message: string,
  context?: readonly GithubIssueCreationIntentContext[],
): boolean {
  return hasPendingGithubIssueDraft(context) && isStandaloneCreationConfirmation(message);
}
