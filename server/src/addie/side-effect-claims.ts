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
  { name: 'GitHub issue', tools: ['create_github_issue'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:just\s+)?(?:filed|opened|created|submitted)\s+(?:(?:an?\s+)?(?:GitHub\s+)?issue\b|#\d+\b)|\b(?:filed|opened|created|submitted)\s+(?:an?\s+)?GitHub\s+issue\b|\b(?:GitHub\s+)?issue(?:\s+#\d+)?\s+(?:(?:was|has been)\s+)?(?:filed|opened|created|submitted)\b/i },
  { name: 'invoice sent', tools: ['send_invoice', 'confirm_send_invoice'], pattern: /\b(?:I(?:'ve| have)?|we)\s+sent\s+(?:the\s+)?invoice\b|\b(?:done\s*[—:-]\s*)?invoice\s+(?:(?:was|has been)\s+)?sent\b/i },
  { name: 'invoice resent', tools: ['resend_invoice'], pattern: /\b(?:I(?:'ve| have)?|we)\s+resent\s+(?:the\s+)?invoice\b|\binvoice\s+(?:was|has been)\s+resent\b/i },
  { name: 'billing update', tools: ['update_billing_email'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:updated|changed)\s+(?:the\s+)?billing\s+email\b|\bbilling\s+email\s+(?:was|has been)\s+(?:updated|changed)\b/i },
  { name: 'escalation', tools: ['resolve_escalation', 'escalate_to_admin'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:resolved|escalated|notified)\s+(?:the\s+)?(?:escalation|support\s+ticket|team)\b|\b(?:the\s+)?team\s+(?:has been|was)\s+notified\b|\bescalation\s+#?\d+\s+(?:was|has been)\s+resolved\b/i },
  { name: 'meeting scheduled', tools: ['schedule_meeting'], pattern: /\b(?:I(?:'ve| have)?|we)\s+scheduled\s+(?:(?:an?|the)\s+)?meeting\b|\bmeeting\s+(?:was|has been)\s+scheduled\b/i },
  { name: 'meeting created', tools: ['schedule_meeting'], pattern: /\b(?:I(?:'ve| have)?|we)\s+created\s+(?:(?:an?|the)\s+)?meeting\b(?!\s+agenda\b)/i },
  { name: 'meeting updated', tools: ['update_meeting'], pattern: /\b(?:I(?:'ve| have)?|we)\s+updated\s+(?:(?:an?|the)\s+)?meeting\b|\bmeeting\s+(?:was|has been)\s+updated\b/i },
  { name: 'meeting cancelled', tools: ['cancel_meeting', 'cancel_meeting_series'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:cancelled|canceled)\s+(?:(?:an?|the)\s+)?meeting\b|\bmeeting\s+(?:was|has been)\s+(?:cancelled|canceled)\b/i },
  { name: 'meeting attendee', tools: ['add_meeting_attendee'], pattern: /\b(?:I(?:'ve| have)?|we)\s+added\s+(?:an?\s+)?attendee\b/i },
  { name: 'meeting RSVP', tools: ['rsvp_to_meeting'], pattern: /\b(?:I(?:'ve| have)?|we)\s+RSVP(?:'d|ed)?\b/i },
  { name: 'payment link', tools: ['create_payment_link'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:created|generated|sent)\s+(?:an?\s+)?payment\s+link\b|\bpayment\s+link\s+(?:was|has been)\s+created\b/i },
  { name: 'direct message', tools: ['send_member_dm'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:sent|delivered)\s+(?:an?\s+)?(?:DM|direct message|notification)\b/i },
  { name: 'content approved', tools: ['approve_content'], pattern: /\b(?:I(?:'ve| have)?|we)\s+approved\s+(?:the\s+)?content\b/i },
  { name: 'content rejected', tools: ['reject_content'], pattern: /\b(?:I(?:'ve| have)?|we)\s+rejected\s+(?:the\s+)?content\b/i },
  { name: 'content published', tools: ['publish_brand_canonical_document', 'create_working_group_post'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:published|posted)\s+(?:the\s+)?(?:content|post|document)\b/i },
  { name: 'content revisions requested', tools: ['request_revisions'], pattern: /\b(?:I(?:'ve| have)?|we)\s+requested revisions\s+(?:to|for)\s+(?:the\s+)?(?:content|post|document)\b/i },
  { name: 'event created', tools: ['create_event'], pattern: /\b(?:I(?:'ve| have)?|we)\s+created\s+(?:an?\s+)?event\b/i },
  { name: 'event updated', tools: ['update_event'], pattern: /\b(?:I(?:'ve| have)?|we)\s+updated\s+(?:an?\s+)?event\b/i },
  { name: 'event invited', tools: ['invite_to_event'], pattern: /\b(?:I(?:'ve| have)?|we)\s+invited\s+(?:an?\s+)?(?:member\s+to\s+)?event\b/i },
  { name: 'event registered', tools: ['manage_event_registrations', 'register_event_interest'], pattern: /\b(?:I(?:'ve| have)?|we)\s+registered\s+(?:an?\s+)?(?:for\s+)?event\b/i },
  { name: 'member or registry update', tools: ['set_my_name', 'set_outreach_preference', 'update_my_profile', 'save_property', 'save_brand', 'save_agent', 'update_company_listing', 'update_company_logo', 'upload_brand_logo', 'join_working_group', 'withdraw_council_interest', 'express_council_interest'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:updated|saved|joined|withdrawn|uploaded)\s+(?:your\s+)?(?:profile|preference|property|brand|agent|working group|logo|listing)\b/i },
  { name: 'certification record', tools: ['complete_certification_module', 'complete_certification_exam', 'start_certification_module', 'start_certification_exam', 'checkpoint_teaching_progress'], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:completed|started|recorded)\s+(?:the\s+)?(?:module|exam|certification|progress)\b/i },
  { name: 'external state change', tools: [...SIDE_EFFECT_TOOL_NAMES], pattern: /\b(?:I(?:'ve| have)?|we)\s+(?:added|approved|attached|bookmarked|cancelled|canceled|completed|created|deleted|disputed|enhanced|expressed|filed|generated|imported|invited|issued|joined|managed|notified|offered|posted|published|registered|removed|renamed|requested|revoked|saved|scheduled|sent|set|started|transferred|triaged|updated|uploaded|verified|withdrew)\s+(?:an?\s+|the\s+|your\s+)?(?:resource|bookmark|reminder|member|organization|chapter|committee|co-leader|document|discount|contact|prospect|invitation|invite|domain|domain\s+challenge|account|record|property|brand|brand\s+ownership|agent|listing|logo|asset|content|post|working\s+group|meeting(?!\s+agenda\b)|attendee|event|event\s+registration|invoice|payment|payment\s+link|escalation|council\s+interest|catalog\s+entry|certification|module|exam|progress|perspective\s+illustration|illustration|portrait|token|introduction|revisions|preference|profile|name|topic\s+subscription)\b|\b(?:the\s+)?(?:resource|bookmark|reminder|member|organization|chapter|committee|co-leader|document|discount|contact|prospect|invitation|invite|domain|account|record|property|brand|agent|listing|logo|asset|content|post|working\s+group|meeting(?!\s+agenda\b)|event|invoice|payment|escalation|catalog\s+entry|certification|module|exam|perspective\s+illustration|illustration|portrait|token|introduction)\s+(?:(?:has|have)\s+been|was)\s+(?:added|approved|attached|bookmarked|cancelled|canceled|completed|created|deleted|disputed|enhanced|filed|generated|imported|invited|issued|joined|managed|notified|offered|posted|published|registered|removed|renamed|requested|revoked|saved|scheduled|sent|set|started|transferred|triaged|updated|uploaded|verified|withdrew)\b/i },
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

const CLAIM_ACTION_TOOL_PREFIX: Readonly<Record<string, string>> = {
  added: 'add_', approved: 'approve_', attached: 'attach_', bookmarked: 'bookmark_',
  cancelled: 'cancel_', canceled: 'cancel_', completed: 'complete_', created: 'create_',
  deleted: 'delete_', disputed: 'dispute_', enhanced: 'enhance_', expressed: 'express_',
  generated: 'generate_', imported: 'import_', invited: 'invite_', issued: 'issue_',
  joined: 'join_', managed: 'manage_', notified: 'notify_', offered: 'offer_', posted: 'post_',
  published: 'publish_', registered: 'register_', removed: 'remove_', renamed: 'rename_',
  requested: 'request_', revoked: 'revoke_', saved: 'save_', scheduled: 'schedule_',
  sent: 'send_', set: 'set_', started: 'start_', transferred: 'transfer_', triaged: 'triage_',
  updated: 'update_', uploaded: 'upload_', verified: 'verify_', withdrew: 'withdraw_',
};

const EXTERNAL_CLAIM_TARGETS = [
    'meeting', 'event', 'invoice', 'payment', 'resource', 'bookmark', 'reminder', 'member',
    'organization', 'chapter', 'committee', 'document', 'discount', 'contact', 'prospect',
    'invitation', 'invite', 'domain', 'account', 'record', 'property', 'brand', 'agent',
    'listing', 'logo', 'asset', 'content', 'post', 'working_group', 'escalation', 'catalog',
    'certification', 'module', 'exam', 'illustration', 'portrait', 'token', 'introduction',
  ] as const;

function externalClaimTargetIn(sentence: string): string | undefined {
  return EXTERNAL_CLAIM_TARGETS.find((candidate) => {
    const expression = candidate === 'meeting'
      ? '\\bmeeting(?!\\s+agenda\\b)\\b'
      : `\\b${candidate.replace('_', '\\s+')}\\b`;
    return new RegExp(expression, 'i').test(sentence);
  });
}

function hasExternalStateChangeClaim(text: string): boolean {
  return Object.keys(CLAIM_ACTION_TOOL_PREFIX).some((action) => (
    EXTERNAL_CLAIM_TARGETS.some((target) => {
      const targetExpression = target === 'meeting'
        ? '\\bmeeting(?!\\s+agenda\\b)\\b'
        : `\\b${target.replace('_', '\\s+')}\\b`;
      return new RegExp(`\\b${action}\\b\\s+(?:an?\\s+|the\\s+|your\\s+)?${targetExpression}`, 'i').test(text)
        || new RegExp(`${targetExpression}\\s+(?:(?:has|have)\\s+been|was)\\s+${action}\\b`, 'i').test(text);
    })
  ));
}

function successfulExternalClaimReceipts(text: string, executions: readonly ToolExecution[]): ToolExecution[] {
  const targetIn = externalClaimTargetIn;
  // Bind action and object from one sentence. Incidental words elsewhere in a
  // mixed response cannot make an otherwise exact receipt look unrelated.
  const claimSentence = text.split(/(?<=[.!?])\s+/).find((sentence) => (
    Object.entries(CLAIM_ACTION_TOOL_PREFIX).some(([verb]) => new RegExp(`\\b${verb}\\b`, 'i').test(sentence))
    && targetIn(sentence) !== undefined
  ));
  if (!claimSentence) return [];
  const action = Object.entries(CLAIM_ACTION_TOOL_PREFIX)
    .find(([verb]) => new RegExp(`\\b${verb}\\b`, 'i').test(claimSentence));
  if (!action) return [];
  const prefix = action[1];
  const target = targetIn(claimSentence);
  return successful(executions, [...SIDE_EFFECT_TOOL_NAMES]).filter((execution) => {
    if (target && !execution.tool_name.includes(target)) return false;
    return execution.tool_name.startsWith(prefix)
      || (target === 'meeting' && action[0] === 'created' && execution.tool_name === 'schedule_meeting');
  });
}

function githubReceipt(execution: ToolExecution): { number: string; url: string } | null {
  const match = /^Issue created:\s*\[#(\d+)\]\((https:\/\/github\.com\/adcontextprotocol\/adcp\/issues\/\d+)\)$/i.exec(execution.result.trim());
  if (!match || !match[2].endsWith(`/issues/${match[1]}`)) return null;
  return { number: match[1], url: match[2] };
}

function githubClaims(text: string): { numbers: string[]; urls: string[] } {
  const urls = text.split(/[\s<>()\[\]]+/).map((token) => token.replace(/[.,:;!?]+$/, '')).filter((token) => {
    try {
      const url = new URL(token);
      return url.protocol === 'https:'
        && url.hostname === 'github.com'
        && /^\/adcontextprotocol\/adcp\/issues\/\d+$/.test(url.pathname);
    } catch {
      return false;
    }
  });
  // Only a number syntactically coupled to a creation assertion is a claimed
  // newly-created issue. A related `#123` elsewhere in the sentence is not.
  const numbers = [...text.matchAll(/\b(?:filed|opened|created|submitted)\s+(?:(?:an?\s+)?(?:GitHub\s+)?issue\s*)?#(\d+)\b|\bissue\s+#(\d+)\s+(?:(?:was|has been)\s+)?(?:filed|opened|created|submitted)\b|\bdone\s*[—:-]\s*#(\d+)\b|\b(?:and|,)\s+(?:(?:an?\s+)?(?:GitHub\s+)?issue\s*)#(\d+)\b/gi)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4]);
  return { numbers, urls };
}

function isGithubSuccessClaim(text: string): boolean {
  if (/\b(?:issue\s+created|(?:filed|opened|created|submitted)\s+(?:an?\s+)?GitHub\s+issue|successfully\s+(?:filed|opened|created|submitted)|done\s*[—:-]\s*#\d+)/i.test(text)) return true;
  return githubClaims(text).urls.length > 0
    && /\b(?:filed|opened|created|submitted|done)\b/i.test(text);
}

/** URLs and identifiers are meaningful outcomes only in an action sentence or when explicitly labelled as one. */
function claimedReceiptUrls(text: string, rule: ClaimRule): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.flatMap((sentence) => {
    const isOutcomeSentence = rule.pattern.test(sentence)
      || /\b(?:issue|ticket|meeting|event|invoice|payment|confirmation|resource)\s+(?:url|link)\b|\b(?:url|link)\s*:/i.test(sentence)
      || /\b(?:join|access|view|open|track|pay)\s+(?:at|here|via)\b/i.test(sentence);
    if (!isOutcomeSentence) return [];
    return receiptUrls(sentence);
  });
}

function receiptUrls(text: string): string[] {
  return text.split(/[\s<>()\[\]"'=]+/).map((token) => token.replace(/[.,:;!?]+$/, '')).filter((token) => {
      try {
        return new URL(token).protocol === 'https:';
      } catch {
        return false;
      }
    });
}

/**
 * Restrict identifier extraction to explicit result labels. This avoids treating
 * ordinary prose or a date as an external identifier while still covering
 * "meeting ID", "invoice #", and a following "ID: ..." result sentence.
 */
function claimedReceiptIdentifiers(text: string): string[] {
  const namedLabel = /\b(?:issue|ticket|meeting|event|invoice|payment|confirmation|record|request|invitation|member|organization|document|bookmark|reminder)\s+(?:id|number|reference|code)\s*(?::|\bis\b|\s+)\s*#?([A-Za-z0-9][A-Za-z0-9_-]{1,})\b/gi;
  const namedHash = /\b(?:issue|ticket|meeting|event|invoice|payment|confirmation|record|request|invitation|member|organization|document|bookmark|reminder)\s*#(\d+)\b/gi;
  const labelled = /\b(?:id|number|reference|confirmation\s+code)\s*(?::|\bis\b|\s+)\s*#?([A-Za-z0-9][A-Za-z0-9_-]{1,})\b/gi;
  return [...text.matchAll(namedLabel), ...text.matchAll(namedHash), ...text.matchAll(labelled)].map((match) => match[1]);
}

function receiptContainsExactValue(receipt: ToolExecution, value: string): boolean {
  if (value.startsWith('https://')) return receiptUrls(receipt.result).includes(value);
  return receipt.result
    .split(/[^A-Za-z0-9_-]+/)
    .some((token) => token === value);
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
    const isExternalStateChange = rule.name === 'external state change';
    if (!githubClaim && !(isExternalStateChange
      ? (rule.pattern.test(text) || hasExternalStateChangeClaim(text))
      : rule.pattern.test(text))) continue;
    const receipts = isExternalStateChange
      ? successfulExternalClaimReceipts(text, executions)
      : successful(executions, rule.tools);
    if (receipts.length === 0) {
      return { text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true, reason: `unverified_${rule.name.replaceAll(' ', '_')}_claim` };
    }
    if (rule.name !== 'GitHub issue') {
      const claimedUrls = claimedReceiptUrls(text, rule);
      const claimedIdentifiers = claimedReceiptIdentifiers(text);
      const claimedValues = [...claimedUrls, ...claimedIdentifiers];
      if (claimedValues.length > 0 && !receipts.some((receipt) => (
        claimedValues.every((value) => receiptContainsExactValue(receipt, value))
      ))) {
        return { text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true, reason: 'side_effect_receipt_claim_mismatch' };
      }
      continue;
    }
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
