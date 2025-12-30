/**
 * Addie - AAO's Intelligent Community Agent
 *
 * Export all Addie functionality
 */

export {
  initializeAddie,
  setAddieBotUserId,
  isAddieReady,
  handleAssistantThreadStarted,
  handleAssistantMessage,
  handleAppMention,
  sendAccountLinkedMessage,
  invalidateAddieRulesCache,
} from './handler.js';

export type {
  AssistantThreadStartedEvent,
  AssistantThreadContextChangedEvent,
  AppMentionEvent,
  AssistantMessageEvent,
  AddieInteractionLog,
} from './types.js';
