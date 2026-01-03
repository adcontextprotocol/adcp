/**
 * Addie Home Module
 *
 * Exports for the Addie App Home experience.
 */

// Types
export type {
  HomeContent,
  GreetingSection,
  AlertSection,
  AlertSeverity,
  QuickAction,
  ActivityItem,
  ActivityType,
  UserStats,
  AdminPanel,
  GoalProgress,
} from './types.js';

// Service
export { getHomeContent, type GetHomeContentOptions } from './home-service.js';

// Cache
export { getHomeContentCache, invalidateHomeCache, HomeContentCache } from './cache.js';

// Slack Renderer
export { renderHomeView, renderErrorView } from './slack-renderer.js';

// Web Service
export { getWebHomeContent } from './web-home-service.js';

// HTML Renderer
export { renderHomeHTML, ADDIE_HOME_CSS } from './html-renderer.js';
