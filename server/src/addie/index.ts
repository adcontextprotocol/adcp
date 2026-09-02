/**
 * Addie - AAO's Intelligent Community Agent
 *
 * Export all Addie functionality.
 * Uses Slack Bolt SDK with the Assistant class for proper assistant support.
 */

export {
  initializeAddieBolt,
  getAddieBoltApp,
  getAddieBoltRouter,
  isAddieBoltReady,
  sendAccountLinkedMessage,
  invalidateAddieRulesCache,
} from './bolt-app.js';

export { isSlackUserAAOAdmin, invalidateAdminStatusCache } from './mcp/admin-tools.js';

export { invalidateMemberContextCache } from './member-context.js';

export type {
  AssistantThreadStartedEvent,
  AssistantThreadContextChangedEvent,
  AppMentionEvent,
  AssistantMessageEvent,
  AddieInteractionLog,
} from './types.js';
