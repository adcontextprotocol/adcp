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
 * Idempotent: safe to call on webhook retries.
 */

import { createLogger } from '../logger.js';
import { MemberDatabase } from '../db/member-db.js';
import { recordProfilePublishedIfNeeded } from './profile-publish-event.js';
import { slugify } from './collection-feed-sync.js';

const logger = createLogger('member-profile-autopublish');

const MAX_SLUG_COLLISIONS = 99;

export type AutopublishAction = 'created' | 'published' | 'noop';

export interface AutopublishResult {
  action: AutopublishAction;
  profileId?: string;
  slug?: string;
}

/**
 * Ensure the given org has a public member directory listing. Creates a new
 * profile with is_public=true if none exists; flips an existing unpublished
 * profile to public.
 *
 * Callers should pass a source tag identifying the activation path so the
 * audit trail on `org_activities` is attributable (e.g. "stripe:subscription.created").
 */
export async function ensureMemberProfilePublished(params: {
  orgId: string;
  orgName: string;
  source: string;
}): Promise<AutopublishResult> {
  const memberDb = new MemberDatabase();

  const existing = await memberDb.getProfileByOrgId(params.orgId);

  if (existing?.is_public) {
    return { action: 'noop', profileId: existing.id };
  }

  if (existing) {
    await memberDb.updateProfile(existing.id, { is_public: true });
    await recordProfilePublishedIfNeeded(
      params.orgId,
      existing.is_public,
      true,
      params.source,
    );
    logger.info(
      { orgId: params.orgId, profileId: existing.id, source: params.source },
      'Auto-published existing member profile on membership activation',
    );
    return { action: 'published', profileId: existing.id };
  }

  const slug = await pickAvailableSlug(params.orgName, memberDb);
  const created = await memberDb.createProfile({
    workos_organization_id: params.orgId,
    display_name: params.orgName,
    slug,
    is_public: true,
  });
  await recordProfilePublishedIfNeeded(
    params.orgId,
    false,
    true,
    params.source,
  );
  logger.info(
    { orgId: params.orgId, profileId: created.id, slug, source: params.source },
    'Auto-created and published member profile on membership activation',
  );
  return { action: 'created', profileId: created.id, slug };
}

async function pickAvailableSlug(orgName: string, memberDb: MemberDatabase): Promise<string> {
  const base = slugify(orgName) || 'member';
  if (await memberDb.isSlugAvailable(base)) return base;

  for (let i = 2; i <= MAX_SLUG_COLLISIONS; i++) {
    const candidate = `${base}-${i}`;
    if (await memberDb.isSlugAvailable(candidate)) return candidate;
  }

  return `${base}-${Date.now()}`;
}
