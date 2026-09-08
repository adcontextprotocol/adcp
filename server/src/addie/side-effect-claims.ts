/** Terminal receipt guard for claims about actions outside the conversation. */
import type { ToolExecution } from './model-providers/tool-orchestration.js';
import { legacyResultIndicatesFailure } from './tool-result-contract.js';

export const UNCONFIRMED_SIDE_EFFECT_FALLBACK =
  "I couldn't confirm that external action was completed. Please check the result and retry the request if needed; I can't confirm an identifier or link.";

/** Every known Addie mutation is conservative replay-sensitive. */
export const SIDE_EFFECT_TOOL_NAMES = new Set<string>([
  'add_committee_co_leader', 'add_committee_document', 'add_meeting_attendee', 'add_to_brand_refs',
  'approve_content', 'attach_content_asset', 'bookmark_resource', 'cancel_meeting', 'cancel_meeting_series',
  'checkpoint_teaching_progress', 'comment_on_moltbook', 'complete_certification_exam', 'complete_certification_module',
  'confirm_send_invoice', 'create_event', 'create_github_issue', 'create_payment_link', 'create_working_group_post',
  'delete_committee_document', 'dispute_catalog_entry', 'enhance_property', 'escalate_to_admin',
  'express_council_interest', 'generate_perspective_illustration', 'import_brand_properties', 'invite_to_event',
  'issue_conformance_token', 'join_working_group', 'manage_committee_topics', 'manage_event_registrations',
  'notify_pending_verification', 'offer_portrait_generation', 'post_to_moltbook', 'propose_content',
  'propose_news_source', 'publish_brand_canonical_document', 'reject_content', 'remove_committee_co_leader',
  'remove_saved_agent', 'request_brand_domain_challenge', 'request_introduction', 'request_revisions',
  'request_working_group_invitation', 'rsvp_to_meeting',
  'save_agent', 'save_brand', 'save_learner_feedback', 'save_property', 'schedule_meeting', 'send_invoice',
  'send_member_dm', 'set_my_name', 'set_outreach_preference', 'setup_test_agent', 'start_certification_exam',
  'start_certification_module', 'update_committee_document', 'update_company_listing', 'update_company_logo',
  'update_event', 'update_meeting', 'update_my_profile', 'update_topic_subscriptions', 'upload_brand_logo',
  'verify_brand_domain_challenge', 'withdraw_council_interest',
  // Legacy admin mutations whose definitions predate replaySafety metadata.
  'resend_invoice', 'send_payment_request', 'grant_discount', 'remove_discount',
  'add_committee_leader', 'remove_committee_leader', 'add_working_group_member',
  'remove_working_group_member', 'rename_working_group', 'revoke_invite',
  'add_member_to_org', 'update_org_member_role', 'update_member_profile',
  'update_member_logo', 'update_user_name', 'transfer_brand_ownership',
  'merge_organizations', 'ban_entity', 'unban_entity', 'set_reminder',
  'manage_organization_domains', 'confirm_org_stripe_customer_update',
  'update_billing_email', 'resolve_escalation', 'register_event_interest',
]);

export function isSideEffectTool(toolName: string): boolean {
  // Old tool definitions are not universally annotated with replaySafety.
  // This conservative verb fallback errs toward preventing a duplicate.
  return SIDE_EFFECT_TOOL_NAMES.has(toolName)
    || /^(?:add|approve|attach|ban|bookmark|cancel|checkpoint|claim|comment|complete|confirm|connect|create|delete|dispute|end|enhance|enrich|express|generate|grant|import|invite|issue|join|manage|merge|notify|offer|post|propose|publish|reject|remove|rename|request|resend|revoke|run|save|schedule|send|set|setup|start|transfer|triage|unban|update|upload|verify|withdraw)_/.test(toolName);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Stable request-local idempotency key; it intentionally contains no receipt data. */
export function sideEffectReplayKey(toolName: string, input: unknown): string {
  return `${toolName}\0${canonicalJson(input)}`;
}

interface ClaimRule {
  readonly name: string;
  readonly tools: readonly string[];
  readonly pattern: RegExp;
}

// Centrally auditable, conservative coverage of user-visible mutations. Model
// prose never supplies confirmation; only the current request ledger can.
const SIDE_EFFECT_CLAIM_RULES: readonly ClaimRule[] = [
  { name: 'GitHub issue', tools: ['create_github_issue'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:just\s+)?(?:filed|opened|created|submitted)\s+(?:(?:an?\s+)?(?:GitHub\s+)?issue\b|#\d+\b|https:\/\/github\.com\/adcontextprotocol\/adcp\/issues\/\d+\b)|\b(?:filed|opened|created|submitted)\s+(?:an?\s+)?GitHub\s+issue\b|\b(?:GitHub\s+)?issue(?:\s+(?:#\d+|https:\/\/github\.com\/adcontextprotocol\/adcp\/issues\/\d+))?\s+(?:(?:was|has been)\s+)?(?:filed|opened|created|submitted)\b/i },
  { name: 'invoice', tools: ['resend_invoice', 'send_invoice', 'confirm_send_invoice'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:sent|resent)\s+(?:the\s+)?invoice\b|\binvoice\s+(?:was|has been)\s+(?:sent|resent)\b/i },
  { name: 'billing update', tools: ['update_billing_email'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:updated|changed)\s+(?:the\s+)?billing\s+email\b|\bbilling\s+email\s+(?:was|has been)\s+(?:updated|changed)\b/i },
  { name: 'escalation', tools: ['resolve_escalation', 'escalate_to_admin'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:resolved|escalated|notified)\s+(?:the\s+)?(?:escalation|support\s+ticket|team)\b|\b(?:the\s+)?team\s+(?:has been|was)\s+notified\b|\bescalation\s+#?\d+\s+(?:was|has been)\s+resolved\b/i },
  { name: 'meeting', tools: ['schedule_meeting', 'update_meeting', 'cancel_meeting', 'cancel_meeting_series', 'add_meeting_attendee', 'rsvp_to_meeting'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:scheduled|updated|cancelled|canceled|added)\s+(?:an?\s+)?(?:meeting|attendee)\b|\bmeeting\s+(?:was|has been)\s+(?:scheduled|updated|cancelled|canceled)\b/i },
  { name: 'payment link', tools: ['create_payment_link'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:created|generated|sent)\s+(?:an?\s+)?payment\s+link\b|\bpayment\s+link\s+(?:was|has been)\s+created\b/i },
  { name: 'direct message', tools: ['send_member_dm'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:sent|delivered)\s+(?:an?\s+)?(?:DM|direct message|notification)\b/i },
  { name: 'content decision', tools: ['approve_content', 'reject_content', 'request_revisions', 'publish_brand_canonical_document', 'create_working_group_post'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:approved|rejected|published|posted|requested revisions)\s+(?:the\s+)?(?:content|post|document)\b/i },
  { name: 'event change', tools: ['create_event', 'update_event', 'invite_to_event', 'manage_event_registrations', 'register_event_interest'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:created|updated|invited|registered)\s+(?:an?\s+)?event\b/i },
  { name: 'member or registry update', tools: ['set_my_name', 'set_outreach_preference', 'update_my_profile', 'save_property', 'save_brand', 'save_agent', 'update_company_listing', 'update_company_logo', 'upload_brand_logo', 'join_working_group', 'withdraw_council_interest', 'express_council_interest'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:updated|saved|joined|withdrawn|uploaded)\s+(?:your\s+)?(?:profile|preference|property|brand|agent|working group|logo|listing)\b/i },
  { name: 'certification record', tools: ['complete_certification_module', 'complete_certification_exam', 'start_certification_module', 'start_certification_exam', 'checkpoint_teaching_progress'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:completed|started|recorded)\s+(?:the\s+)?(?:module|exam|certification|progress)\b/i },
  { name: 'external state change', tools: [...SIDE_EFFECT_TOOL_NAMES], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:added|approved|attached|bookmarked|cancelled|canceled|completed|created|deleted|filed|invited|issued|joined|published|registered|removed|renamed|saved|scheduled|sent|updated|uploaded|verified)\s+(?:an?\s+|the\s+|your\s+)?(?:resource|bookmark|reminder|member|organization|chapter|committee|document|discount|contact|prospect|invitation|domain|account|record|property|brand|agent|listing|working\s+group|content|post)\b|\b(?:the\s+)?(?:resource|bookmark|reminder|member|organization|chapter|committee|document|discount|contact|prospect|invitation|domain|account|record)\s+(?:(?:has|have)\s+been|was)\s+(?:added|approved|attached|bookmarked|cancelled|canceled|completed|created|deleted|filed|invited|issued|joined|published|registered|removed|renamed|saved|scheduled|sent|updated|uploaded|verified)\b/i },
];

function successful(executions: readonly ToolExecution[], names: readonly string[]): ToolExecution[] {
  return executions.filter((execution) => (
    names.includes(execution.tool_name)
    && !execution.is_error
    && execution.result.trim() !== ''
    && execution.result.trim() !== 'The tool returned no content.'
    && !legacyResultIndicatesFailure(execution.result)
  ));
}

function githubReceipt(execution: ToolExecution): { number: string; url: string } | null {
  const match = /^Issue created:\s*\[#(\d+)\]\((https:\/\/github\.com\/adcontextprotocol\/adcp\/issues\/\d+)\)$/i.exec(execution.result.trim());
  if (!match || !match[2].endsWith(`/issues/${match[1]}`)) return null;
  return { number: match[1], url: match[2] };
}

function githubClaims(text: string): { numbers: string[]; urls: string[] } {
  const urls = [...text.matchAll(/\bhttps:\/\/github\.com\/adcontextprotocol\/adcp\/issues\/\d+\b/gi)].map((match) => match[0]);
  const numbers = [...text.matchAll(/(?:\bissue\s*)?#(\d+)\b/gi)].map((match) => match[1]);
  return { numbers, urls };
}

function isGithubSuccessClaim(text: string): boolean {
  return /\b(?:issue\s+created|(?:filed|opened|created|submitted)\s+(?:an?\s+)?GitHub\s+issue|successfully\s+(?:filed|opened|created|submitted)|done\s*[—:-]\s*(?:#\d+|https:\/\/github\.com\/adcontextprotocol\/adcp\/issues\/\d+))/i.test(text);
}

export interface SideEffectClaimGuardResult {
  readonly text: string;
  readonly enforced: boolean;
  /** Sanitized reason: contains no model-controlled identifiers or prose. */
  readonly reason: string | null;
}

/** Reject a terminal claim unless the current turn contains its success receipt. */
export function enforceSideEffectClaimReceipts(
  text: string,
  executions: readonly ToolExecution[],
): SideEffectClaimGuardResult {
  for (const rule of SIDE_EFFECT_CLAIM_RULES) {
    const githubClaim = rule.name === 'GitHub issue' && isGithubSuccessClaim(text);
    if (!githubClaim && !rule.pattern.test(text)) continue;
    const receipts = successful(executions, rule.tools);
    if (receipts.length === 0) {
      return { text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true, reason: `unverified_${rule.name.replaceAll(' ', '_')}_claim` };
    }
    if (rule.name === 'payment link') {
      const claimedUrls = [...text.matchAll(/https:\/\/[^\s)\]]+/gi)].map((match) => match[0]);
      if (claimedUrls.some((url) => !receipts.some((receipt) => receipt.result.includes(url)))) {
        return { text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true, reason: 'payment_link_receipt_claim_mismatch' };
      }
    }
    if (rule.name !== 'GitHub issue') continue;
    const trusted = receipts.map(githubReceipt);
    if (trusted.some((receipt) => receipt === null)) {
      return { text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true, reason: 'malformed_github_issue_receipt' };
    }
    const claimed = githubClaims(text);
    const numbers = new Set(trusted.map((receipt) => receipt!.number));
    const urls = new Set(trusted.map((receipt) => receipt!.url));
    const claimedNumbers = new Set([
      ...claimed.numbers,
      ...claimed.urls.map((url) => /\/issues\/(\d+)$/i.exec(url)![1]),
    ]);
    if (
      claimed.numbers.some((number) => !numbers.has(number))
      || claimed.urls.some((url) => !urls.has(url))
      || (receipts.length > 1 && claimedNumbers.size === 0)
      || (claimedNumbers.size > 0 && (claimedNumbers.size !== numbers.size || [...numbers].some((number) => !claimedNumbers.has(number))))
    ) {
      return { text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true, reason: 'github_issue_receipt_claim_mismatch' };
    }
  }
  return { text, enforced: false, reason: null };
}
