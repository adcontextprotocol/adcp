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

interface GithubIssueCreationResult {
  readonly kind: 'github_issue_creation';
  readonly status: 'ok';
  readonly receipt: GithubIssueCreationReceipt;
  readonly model_context: string;
  readonly user_summary: string;
}

function canonicalReceipt(input: { issueNumber: number; issueUrl: string }): GithubIssueCreationReceipt | null {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) return null;
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
  const receipt = candidate.receipt;
  if (!receipt || receipt.toolName !== 'create_github_issue') return null;
  return canonicalReceipt(receipt);
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

/**
 * This is intentionally only an input-intent convenience for existing text
 * surfaces. It never parses model output and never authorizes success; an
 * explicit caller-owned `githubIssueCreationRequested` option can replace it.
 */
export function isExplicitGithubIssueCreationRequest(message: string): boolean {
  return /\b(?:create|file|open|submit)\b[\s\S]{0,80}\bgithub\s+issue\b/i.test(message);
}
