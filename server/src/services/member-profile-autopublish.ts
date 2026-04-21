/**
 * Auto-publish a member directory listing when an organization's membership
 * activates for the first time.
 *
 * Hooked into the Stripe `customer.subscription.created` and `invoice.paid`
 * (non-subscription membership) webhook paths. Deliberately NOT hooked into
 * `subscription.updated` — once a profile exists and is_public=false, that
 * state is treated as intentional (admin or user unpublished) and renewal
 * events should not clobber it.
 *
 * Idempotent: safe to call on webhook retries and concurrent deliveries.
 */

import { createLogger } from '../logger.js';
import { MemberDatabase } from '../db/member-db.js';
import { recordProfilePublishedIfNeeded } from './profile-publish-event.js';
import { slugify } from './collection-feed-sync.js';

const logger = createLogger('member-profile-autopublish');

const MAX_SLUG_SUFFIX = 99;
const MAX_CREATE_RETRIES = 3;
const PG_UNIQUE_VIOLATION = '23505';
const SYSTEM_ACTOR = 'system';

export type AutopublishAction = 'created' | 'published' | 'noop' | 'skipped';

export interface AutopublishResult {
  action: AutopublishAction;
  profileId?: string;
  slug?: string;
  reason?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === PG_UNIQUE_VIOLATION;
}

/**
 * Ensure the given org has a public member directory listing. Creates a new
 * profile with is_public=true if none exists; flips an existing unpublished
 * profile to public.
 *
 * Callers should pass a source tag identifying the activation path so the
 * log line (not the audit table) is attributable. The `org_activities`
 * actor is always `system` because webhooks have no user context — using
 * the source string there would misuse the `logged_by_user_id` column.
 *
 * Skips when `orgName` is empty/falsy: a listing titled "" or with a
 * generic fallback name is worse than no listing.
 */
export async function ensureMemberProfilePublished(params: {
  orgId: string;
  orgName: string;
  source: string;
}): Promise<AutopublishResult> {
  const { orgId, orgName, source } = params;

  if (!orgName || !orgName.trim()) {
    logger.warn(
      { orgId, source },
      'Skipping listing autopublish — org has no name',
    );
    return { action: 'skipped', reason: 'no-org-name' };
  }

  const memberDb = new MemberDatabase();

  const existing = await memberDb.getProfileByOrgId(orgId);

  if (existing?.is_public) {
    return { action: 'noop', profileId: existing.id, slug: existing.slug };
  }

  if (existing) {
    await memberDb.updateProfile(existing.id, { is_public: true });
    await recordProfilePublishedIfNeeded(orgId, existing.is_public, true, SYSTEM_ACTOR);
    logger.info(
      { orgId, profileId: existing.id, source },
      'Auto-published existing member profile on membership activation',
    );
    return { action: 'published', profileId: existing.id, slug: existing.slug };
  }

  // No profile yet — create one with a unique slug. Retry on unique-violation
  // so concurrent webhook deliveries don't leave the org without a listing.
  for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
    const slug = await pickAvailableSlug(orgName, memberDb);
    try {
      const created = await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: orgName,
        slug,
        is_public: true,
      });
      await recordProfilePublishedIfNeeded(orgId, false, true, SYSTEM_ACTOR);
      logger.info(
        { orgId, profileId: created.id, slug, source },
        'Auto-created and published member profile on membership activation',
      );
      return { action: 'created', profileId: created.id, slug };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      // Another webhook delivery beat us to either the slug or the org row.
      // Re-fetch by org: if a profile now exists, treat as noop / publish.
      const concurrent = await memberDb.getProfileByOrgId(orgId);
      if (concurrent) {
        if (concurrent.is_public) {
          logger.info({ orgId, profileId: concurrent.id, source }, 'Profile created concurrently by another webhook — noop');
          return { action: 'noop', profileId: concurrent.id, slug: concurrent.slug };
        }
        await memberDb.updateProfile(concurrent.id, { is_public: true });
        await recordProfilePublishedIfNeeded(orgId, concurrent.is_public, true, SYSTEM_ACTOR);
        logger.info({ orgId, profileId: concurrent.id, source }, 'Profile created concurrently by another webhook — published');
        return { action: 'published', profileId: concurrent.id, slug: concurrent.slug };
      }

      // Slug collision with a different org — retry with a new suffix.
      logger.warn({ orgId, attempt, source }, 'Slug collision on listing autopublish — retrying');
    }
  }

  throw new Error(`Failed to auto-publish member profile for org ${orgId} after ${MAX_CREATE_RETRIES} attempts`);
}

async function pickAvailableSlug(orgName: string, memberDb: MemberDatabase): Promise<string> {
  const base = slugify(orgName) || 'member';
  if (await memberDb.isSlugAvailable(base)) return base;

  for (let i = 2; i <= MAX_SLUG_SUFFIX; i++) {
    const candidate = `${base}-${i}`;
    if (await memberDb.isSlugAvailable(candidate)) return candidate;
  }

  return `${base}-${Date.now()}`;
}
