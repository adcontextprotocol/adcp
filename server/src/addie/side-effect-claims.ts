/**
 * Durable replay fencing for mutations.
 *
 * This module deliberately does not interpret model prose. A model response is
 * never evidence that an external action happened; action-specific receipt
 * modules own that boundary instead.
 */

/** Every known Addie mutation is conservative replay-sensitive. */
export const SIDE_EFFECT_TOOL_NAMES = new Set<string>([
  'add_committee_co_leader', 'add_committee_document', 'add_meeting_attendee', 'add_to_brand_refs',
  'approve_content', 'attach_content_asset', 'bookmark_resource', 'cancel_meeting', 'cancel_meeting_series',
  'checkpoint_teaching_progress', 'comment_on_moltbook', 'complete_certification_exam', 'complete_certification_module',
  'confirm_send_invoice', 'create_event', 'create_github_issue', 'create_payment_link', 'create_working_group_post',
  'delete_committee_document', 'dispute_catalog_entry', 'enhance_property', 'escalate_to_admin',
  'express_council_interest', 'generate_perspective_illustration', 'import_brand_properties', 'invite_to_event',
  'issue_conformance_token', 'join_working_group', 'manage_committee_topics', 'notify_pending_verification',
  'offer_portrait_generation', 'post_to_moltbook', 'propose_content', 'propose_news_source',
  'publish_brand_canonical_document', 'reject_content', 'remove_committee_co_leader', 'remove_saved_agent',
  'request_brand_domain_challenge', 'request_introduction', 'request_revisions', 'request_working_group_invitation',
  'rsvp_to_meeting', 'save_agent', 'save_brand', 'save_learner_feedback', 'save_property', 'schedule_meeting',
  'send_invoice', 'send_member_dm', 'set_my_name', 'set_outreach_preference', 'setup_test_agent',
  'start_certification_exam', 'start_certification_module', 'update_committee_document', 'update_company_listing',
  'update_company_logo', 'update_event', 'update_meeting', 'update_my_profile', 'update_topic_subscriptions',
  'upload_brand_logo', 'verify_brand_domain_challenge', 'withdraw_council_interest',
  // Legacy admin mutations whose definitions predate replaySafety metadata.
  'resend_invoice', 'send_payment_request', 'grant_discount', 'remove_discount', 'add_committee_leader',
  'remove_committee_leader', 'add_working_group_member', 'remove_working_group_member', 'rename_working_group',
  'revoke_invite', 'add_member_to_org', 'update_org_member_role', 'update_member_profile', 'update_member_logo',
  'update_user_name', 'transfer_brand_ownership', 'merge_organizations', 'ban_entity', 'unban_entity',
  'set_reminder', 'manage_organization_domains', 'confirm_org_stripe_customer_update', 'update_billing_email',
  'resolve_escalation', 'register_event_interest',
]);

export function isSideEffectTool(toolName: string): boolean {
  // Old tool definitions are not universally annotated with replaySafety.
  // This conservative fallback protects dispatch/replay only; it never
  // authorizes a model-authored success message or identifier.
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
