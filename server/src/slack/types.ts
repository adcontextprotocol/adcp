/**
 * Slack integration types for AAO
 */

// Database record types

export type SlackMappingStatus = 'mapped' | 'unmapped' | 'pending_verification';
export type SlackMappingSource = 'email_auto' | 'manual_admin' | 'user_claimed';

export interface SlackUserMapping {
  id: string;
  slack_user_id: string;
  slack_email: string | null;
  slack_display_name: string | null;
  slack_real_name: string | null;
  slack_is_bot: boolean;
  slack_is_deleted: boolean;
  workos_user_id: string | null;
  mapping_status: SlackMappingStatus;
  mapping_source: SlackMappingSource | null;
  nudge_opt_out: boolean;
  nudge_opt_out_at: Date | null;
  last_nudge_at: Date | null;
  nudge_count: number;
  last_slack_sync_at: Date | null;
  last_slack_activity_at: Date | null;
  mapped_at: Date | null;
  mapped_by_user_id: string | null;
  // Proactive outreach tracking (from migration 070)
  last_outreach_at: Date | null;
  outreach_opt_out: boolean;
  outreach_opt_out_at: Date | null;
  // Timezone offset in seconds from UTC (from Slack)
  slack_tz_offset: number | null;
  created_at: Date;
  updated_at: Date;
}

// Slack API response types

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  color?: string;
  real_name?: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  profile: SlackUserProfile;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_bot: boolean;
  is_app_user?: boolean;
  updated?: number;
}

export interface SlackUserProfile {
  title?: string;
  phone?: string;
  skype?: string;
  real_name?: string;
  real_name_normalized?: string;
  display_name?: string;
  display_name_normalized?: string;
  status_text?: string;
  status_emoji?: string;
  status_expiration?: number;
  avatar_hash?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  image_24?: string;
  image_32?: string;
  image_48?: string;
  image_72?: string;
  image_192?: string;
  image_512?: string;
  team?: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  created: number;
  is_archived: boolean;
  is_general: boolean;
  unlinked?: number;
  name_normalized: string;
  is_shared: boolean;
  is_org_shared: boolean;
  is_pending_ext_shared?: boolean;
  pending_shared?: string[];
  context_team_id?: string;
  updated?: number;
  creator: string;
  is_member: boolean;
  num_members?: number;
  topic?: {
    value: string;
    creator: string;
    last_set: number;
  };
  purpose?: {
    value: string;
    creator: string;
    last_set: number;
  };
}

// API input/output types

export interface SlackUserMappingWithDetails extends SlackUserMapping {
  // Cached WorkOS user info when mapped
  workos_email?: string;
  workos_first_name?: string;
  workos_last_name?: string;
  workos_org_name?: string;
}

export interface SyncSlackUsersResult {
  total_synced: number;
  new_users: number;
  updated_users: number;
  auto_mapped: number;
  errors: string[];
}

export interface SlackMappingStats {
  total: number;
  mapped: number;
  unmapped: number;
  pending_verification: number;
  bots: number;
  deleted: number;
  opted_out: number;
}

export interface LinkSlackUserInput {
  slack_user_id: string;
  workos_user_id: string;
  mapped_by_user_id: string;
}

export interface UnlinkSlackUserInput {
  slack_user_id: string;
  unlinked_by_user_id: string;
}

// Slack API pagination

export interface SlackPaginatedResponse<T> {
  ok: boolean;
  members?: T[];
  channels?: T[];
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

// Slack message types for Block Kit

export interface SlackBlockMessage {
  channel?: string;
  text: string;
  blocks?: SlackBlock[];
  thread_ts?: string;
  reply_broadcast?: boolean;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: SlackElement[];
  accessory?: SlackElement;
}

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
  verbatim?: boolean;
}

export interface SlackElement {
  type: string;
  text?: SlackTextObject;
  action_id?: string;
  url?: string;
  value?: string;
  style?: 'primary' | 'danger';
}

// Slack event types

export interface SlackEventWrapper {
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackEvent;
  type: 'event_callback' | 'url_verification';
  event_id?: string;
  event_time?: number;
  challenge?: string;
}

export interface SlackEvent {
  type: string;
  user?: string;
  channel?: string;
  ts?: string;
  text?: string;
  [key: string]: unknown;
}

// Slash command types

export interface SlackSlashCommand {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  api_app_id: string;
  is_enterprise_install: string;
  response_url: string;
  trigger_id: string;
}
