/**
 * Brand Logo Background Backfill
 *
 * Classifies which background each stored logo is drawn for (light-bg or
 * dark-bg) from its rendered pixels, for rows inserted before classification
 * ran at insert time. Works through a small batch per run, one logo at a time,
 * oldest first; once every row is classified a run is one indexed query.
 */

import { createLogger } from '../../logger.js';
import { BrandLogoDatabase } from '../../db/brand-logo-db.js';
import { classifyLogoBackground } from '../../services/logo-rendition.js';

const logger = createLogger('brand-logo-background-backfill');

const DEFAULT_BATCH_SIZE = 250;

export interface BrandLogoBackgroundBackfillResult {
  scanned: number;
  classified: number;
  unclassifiable: number;
}

export async function runBrandLogoBackgroundBackfillJob(
  options: { limit?: number } = {},
  signal?: AbortSignal,
  brandLogoDb: Pick<BrandLogoDatabase, 'listLogosNeedingBackground' | 'getLogoBytes' | 'setDerivedBackground'> =
    new BrandLogoDatabase(),
): Promise<BrandLogoBackgroundBackfillResult> {
  const result: BrandLogoBackgroundBackfillResult = { scanned: 0, classified: 0, unclassifiable: 0 };
  const pending = await brandLogoDb.listLogosNeedingBackground(options.limit ?? DEFAULT_BATCH_SIZE);

  for (const { id, domain } of pending) {
    if (signal?.aborted) break;
    result.scanned++;
    // Bytes are loaded one row at a time: a row can hold up to 5 MB.
    const logo = await brandLogoDb.getLogoBytes(id);
    if (!logo) continue;
    const background = await classifyLogoBackground(logo.data, logo.content_type);
    // Unclassifiable rows (an ICO, a blank image) are recorded too, so the
    // next run does not pick them up again.
    await brandLogoDb.setDerivedBackground(id, background);
    if (background) {
      result.classified++;
    } else {
      result.unclassifiable++;
      logger.debug({ id, domain, contentType: logo.content_type }, 'Logo background unclassifiable');
    }
  }

  return result;
}
