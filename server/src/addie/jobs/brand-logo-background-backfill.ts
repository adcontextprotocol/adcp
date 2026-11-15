/**
 * Brand Logo Background Backfill
 *
 * Classifies which background each stored logo is drawn for (light-bg or
 * dark-bg) from its rendered pixels. This job is the only classifier: uploads
 * and rehosts insert with derived_background NULL, and a run every minute
 * picks them up, so a new logo is classified within about a minute.
 *
 * Each logo is claimed before it is rendered (claimLogoForBackground), one at
 * a time, oldest first. Renders go through the same limiter as PNG
 * renditions, so the job never adds a render beyond the process-wide cap.
 *
 * - A logo that cannot be rendered (an ICO, bytes that do not decode, no
 *   visible ink) is recorded as unclassifiable (NULL) and not retried.
 * - A logo whose render takes the process down stays claimed with a NULL
 *   background: it is not retried, so it cannot crash every run.
 * - Any other failure (the render queue is full, an unexpected error, a
 *   database error) releases the claim so a later run retries the logo. An
 *   unexpected error skips the logo for the rest of this run; a full queue
 *   ends the run.
 */

import { createLogger } from '../../logger.js';
import { BrandLogoDatabase } from '../../db/brand-logo-db.js';
import { classifyLogoBackground, logoRenderLimiter, type DerivedLogoBackground } from '../../services/logo-rendition.js';
import { SemaphoreOverloadedError, type AsyncSemaphore } from '../../utils/async-semaphore.js';

const logger = createLogger('brand-logo-background-backfill');

const DEFAULT_BATCH_SIZE = 250;

export interface BrandLogoBackgroundBackfillResult {
  scanned: number;
  classified: number;
  unclassifiable: number;
  /** Claims released after a transient failure, for a later run to retry. */
  released: number;
}

export async function runBrandLogoBackgroundBackfillJob(
  options: { limit?: number } = {},
  signal?: AbortSignal,
  brandLogoDb: Pick<
    BrandLogoDatabase,
    'claimLogoForBackground' | 'recordDerivedBackground' | 'releaseBackgroundClaim'
  > = new BrandLogoDatabase(),
  renderLimiter: Pick<AsyncSemaphore, 'run'> = logoRenderLimiter,
): Promise<BrandLogoBackgroundBackfillResult> {
  const result: BrandLogoBackgroundBackfillResult = { scanned: 0, classified: 0, unclassifiable: 0, released: 0 };
  const limit = options.limit ?? DEFAULT_BATCH_SIZE;
  const released: string[] = [];

  while (result.scanned < limit && !signal?.aborted) {
    const logo = await brandLogoDb.claimLogoForBackground(released);
    if (!logo) break;
    result.scanned++;

    let background: DerivedLogoBackground | null;
    try {
      background = await renderLimiter.run(() => classifyLogoBackground(logo.data, logo.content_type));
      await brandLogoDb.recordDerivedBackground(logo.id, background);
    } catch (err) {
      await brandLogoDb.releaseBackgroundClaim(logo.id).catch((releaseErr) => {
        logger.warn({ err: releaseErr, id: logo.id }, 'Failed to release logo background claim');
      });
      released.push(logo.id);
      result.released++;
      if (err instanceof SemaphoreOverloadedError) {
        logger.info({ id: logo.id }, 'Logo renders are saturated; ending this backfill run');
        break;
      }
      logger.warn({ err, id: logo.id, domain: logo.domain }, 'Logo background classification failed; will retry');
      continue;
    }

    if (background) {
      result.classified++;
    } else {
      result.unclassifiable++;
      logger.debug({ id: logo.id, domain: logo.domain, contentType: logo.content_type }, 'Logo background unclassifiable');
    }
  }

  return result;
}
