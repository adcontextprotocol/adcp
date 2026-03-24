import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import { getDigestByDate, getCurrentWeekDigest, recordDigestFeedback } from '../db/digest-db.js';
import { renderDigestWebPage, renderDigestEmail, type DigestSegment } from '../addie/templates/weekly-digest.js';

const logger = createLogger('digest-routes');

export function createDigestRouter(): Router {
  const router = Router();

  /**
   * GET /digest/preview - Admin preview of the current digest for any persona.
   * Query params:
   *   segment: 'website_only' | 'both' | 'slack_only' | 'active' (default: 'both')
   *   firstName: recipient first name (default: none)
   *   date: YYYY-MM-DD (default: most recent digest)
   */
  router.get('/preview', async (req: Request, res: Response) => {
    // Simple admin check - must be authenticated
    if (!req.user) {
      res.status(401).send('Authentication required');
      return;
    }

    const VALID_SEGMENTS = new Set(['website_only', 'slack_only', 'both', 'active']);
    const segmentParam = typeof req.query.segment === 'string' ? req.query.segment : 'both';
    const segment: DigestSegment = VALID_SEGMENTS.has(segmentParam) ? segmentParam as DigestSegment : 'both';
    const firstName = typeof req.query.firstName === 'string' ? req.query.firstName.slice(0, 50) : undefined;
    const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;

    try {
      let digest;
      let editionDate: string;

      if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        digest = await getDigestByDate(dateParam);
        editionDate = dateParam;
      } else {
        digest = await getCurrentWeekDigest();
        editionDate = digest
          ? new Date(digest.edition_date).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];
      }

      if (!digest) {
        res.status(404).send('No digest found. Generate a draft first.');
        return;
      }

      // Render with 'preview' tracking ID so links are not tracked
      const { html } = renderDigestEmail(digest.content, 'preview', editionDate, segment, firstName);

      // Wrap in a simple page with segment switcher
      const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Digest Preview - ${segment} - ${editionDate}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f5f5f5; }
    .preview-bar { background: #1a1a2e; color: white; padding: 12px 20px; display: flex; align-items: center; gap: 16px; font-size: 14px; flex-wrap: wrap; }
    .preview-bar a { color: #93c5fd; text-decoration: none; }
    .preview-bar a:hover { text-decoration: underline; }
    .preview-bar .active { color: white; font-weight: 600; text-decoration: underline; }
    .preview-content { max-width: 640px; margin: 20px auto; padding: 20px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .preview-bar label { font-weight: 600; }
  </style>
</head>
<body>
  <div class="preview-bar">
    <label>Segment:</label>
    ${(['website_only', 'both', 'slack_only', 'active'] as const).map((s) =>
      `<a href="?segment=${s}&firstName=${encodeURIComponent(firstName || '')}&date=${editionDate}" class="${s === segment ? 'active' : ''}">${s}</a>`
    ).join(' ')}
    <span style="margin-left: auto;">Status: ${digest.status} | ${editionDate}</span>
  </div>
  <div class="preview-content">
    ${html}
  </div>
</body>
</html>`;

      res.type('html').send(page);
    } catch (error) {
      logger.error({ error }, 'Failed to render digest preview');
      res.status(500).send('Internal server error');
    }
  });

  /**
   * GET /digest/:date - Public web view of a sent digest
   * Unlisted (noindex) but accessible without auth for email "view in browser" links
   */
  router.get('/:date', async (req: Request, res: Response) => {
    const { date } = req.params;

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).send('Invalid date format');
      return;
    }

    try {
      const digest = await getDigestByDate(date);

      if (!digest || digest.status !== 'sent') {
        res.status(404).send('Digest not found');
        return;
      }

      const html = renderDigestWebPage(digest.content, date);
      res.type('html').send(html);
    } catch (error) {
      logger.error({ error, date }, 'Failed to render digest');
      res.status(500).send('Internal server error');
    }
  });

  /**
   * GET /digest/:date/feedback - Record thumbs up/down feedback
   * Redirects back to digest after recording
   */
  router.get('/:date/feedback', async (req: Request, res: Response) => {
    const { date } = req.params;
    const { vote, t: trackingId } = req.query;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).send('Invalid date format');
      return;
    }

    if (vote === 'yes' || vote === 'no') {
      try {
        await recordDigestFeedback(date, vote, typeof trackingId === 'string' ? trackingId : undefined);
        logger.info({ date, vote, trackingId }, 'Digest feedback recorded');
      } catch (error) {
        logger.error({ error, date, vote }, 'Failed to record digest feedback');
      }
    }

    res.redirect(`/digest/${date}`);
  });

  return router;
}
