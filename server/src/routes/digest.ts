import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import { getDigestByDate, recordDigestFeedback } from '../db/digest-db.js';
import { renderDigestWebPage } from '../addie/templates/weekly-digest.js';

const logger = createLogger('digest-routes');

export function createDigestRouter(): Router {
  const router = Router();

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
