const PERMANENT_DM_DELIVERY_ERRORS = new Set([
  'restricted_action_read_only_channel',
]);

/** Extract Slack's API error name from @slack/web-api platform errors. */
export function getSlackApiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null;
  const data = error.data;
  if (!data || typeof data !== 'object' || !('error' in data)) return null;
  return typeof data.error === 'string' ? data.error : null;
}

/** Errors where retrying or escalating cannot make the current DM writable. */
export function isPermanentDmDeliveryError(error: unknown): boolean {
  const code = getSlackApiErrorCode(error);
  return code !== null && PERMANENT_DM_DELIVERY_ERRORS.has(code);
}
