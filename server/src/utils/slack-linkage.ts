import type { SlackUserMapping } from '../slack/types.js';

export function hasActiveSlackLink(
  mapping: Pick<SlackUserMapping, 'slack_user_id' | 'mapping_status' | 'slack_is_deleted'> | null,
): boolean {
  return Boolean(
    mapping?.slack_user_id
    && mapping.mapping_status === 'mapped'
    && !mapping.slack_is_deleted
  );
}
