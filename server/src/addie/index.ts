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

// Legacy exports for backward compatibility during migration
// TODO: Remove these once all callers are updated to use Bolt
export {
  initializeAddie,
  setAddieBotUserId,
  isAddieReady,
  handleAssistantThreadStarted,
  handleAssistantMessage,
  handleAppMention,
  sendAccountLinkedMessage as sendAccountLinkedMessageLegacy,
  invalidateAddieRulesCache as invalidateAddieRulesCacheLegacy,
} from './handler.js';

export { invalidateMemberContextCache } from './member-context.js';

export type {
  AssistantThreadStartedEvent,
  AssistantThreadContextChangedEvent,
  AppMentionEvent,
  AssistantMessageEvent,
  AddieInteractionLog,
} from './types.js';
