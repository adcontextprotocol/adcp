/**
 * Addie Home Content Types
 *
 * Platform-agnostic data structures for the Addie Home experience.
 * These types are consumed by renderers (Slack Block Kit, HTML, etc.)
 */

/**
 * Complete home content for a user
 */
export interface HomeContent {
  greeting: GreetingSection;
  alerts: AlertSection[];
  quickActions: QuickAction[];
  activity: ActivityItem[];
  stats: UserStats | null;
  adminPanel: AdminPanel | null;
  lastUpdated: Date;
}

/**
 * Personalized greeting with user context
 */
export interface GreetingSection {
  userName: string;
  orgName: string | null;
  isMember: boolean;
  isLinked: boolean;
}

/**
 * Alert severity levels
 */
export type AlertSeverity = 'urgent' | 'warning' | 'info';

/**
 * Alert requiring user attention
 */
export interface AlertSection {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** Button label */
  actionLabel?: string;
  /** External URL to open */
  actionUrl?: string;
  /** Slack action_id for interactive handling */
  actionId?: string;
}

/**
 * Quick action button
 */
export interface QuickAction {
  id: string;
  label: string;
  description?: string;
  /** Slack action_id */
  actionId: string;
  /** Visual prominence */
  style?: 'primary' | 'default';
}

/**
 * Activity feed item types
 */
export type ActivityType = 'event' | 'working_group';

/**
 * Activity feed item
 */
export interface ActivityItem {
  id: string;
  type: ActivityType;
  title: string;
  description: string;
  timestamp: Date;
  url?: string;
  metadata?: Record<string, unknown>;
}

/**
 * User engagement and membership stats
 */
export interface UserStats {
  memberSince: Date | null;
  workingGroupCount: number;
  slackActivity: {
    messages30d: number;
    activeDays30d: number;
  } | null;
  subscriptionStatus: string | null;
  renewalDate: Date | null;
}

/**
 * Admin-only panel content
 */
export interface AdminPanel {
  flaggedThreadCount: number;
  insightGoals: GoalProgress[];
}

/**
 * Insight goal progress tracking
 */
export interface GoalProgress {
  goalName: string;
  current: number;
  target: number | null;
}
