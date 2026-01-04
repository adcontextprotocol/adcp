/**
 * Admin routes index
 *
 * Re-exports all admin route modules for convenient imports.
 */

export { createAdminSlackRouter } from './slack.js';
export { createAdminEmailRouter } from './email.js';
export { createAdminFeedsRouter } from './feeds.js';
export { createAdminNotificationChannelsRouter } from './notification-channels.js';
export { createAdminUsersRouter } from './users.js';
export { createAdminSettingsRouter } from './settings.js';

// Core admin route setup functions
export { setupProspectRoutes } from './prospects.js';
export { setupOrganizationRoutes } from './organizations.js';
export { setupEnrichmentRoutes } from './enrichment.js';
export { setupDomainRoutes } from './domains.js';
export { setupCleanupRoutes } from './cleanup.js';
export { setupStatsRoutes } from './stats.js';
export { setupDiscountRoutes } from './discounts.js';
export { setupMembersRoutes } from './members.js';
