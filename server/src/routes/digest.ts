import { Router, type Request, type Response } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getDigestByDate, getCurrentWeekDigest, getRecentDigests, recordDigestFeedback, isLegacyContent, type PersonaCluster, type DigestContent } from '../db/digest-db.js';
import { generateDigestSubject } from '../addie/services/digest-builder.js';
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
  router.get('/preview', requireAuth, requireAdmin, async (req: Request, res: Response) => {

    const VALID_SEGMENTS = new Set(['website_only', 'slack_only', 'both', 'active']);
    const segmentParam = typeof req.query.segment === 'string' ? req.query.segment : 'both';
    const segment: DigestSegment = VALID_SEGMENTS.has(segmentParam) ? segmentParam as DigestSegment : 'both';
    const firstName = typeof req.query.firstName === 'string' ? req.query.firstName.slice(0, 50) : undefined;
    const VALID_CLUSTERS = new Set(['builder', 'strategist', 'newcomer']);
    const clusterParam = typeof req.query.persona === 'string' ? req.query.persona : undefined;
    const personaCluster: PersonaCluster | undefined = clusterParam && VALID_CLUSTERS.has(clusterParam) ? clusterParam as PersonaCluster : undefined;
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

      if (isLegacyContent(digest.content)) {
        res.status(410).send('This digest uses a legacy format and cannot be previewed.');
        return;
      }

      // Render with 'preview' tracking ID so links are not tracked
      const { html } = renderDigestEmail(digest.content, 'preview', editionDate, segment, firstName, undefined, personaCluster);

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
      `<a href="?segment=${s}&firstName=${encodeURIComponent(firstName || '')}&date=${editionDate}&persona=${personaCluster || ''}" class="${s === segment ? 'active' : ''}">${s}</a>`
    ).join(' ')}
    <span style="margin: 0 8px; color: #555;">|</span>
    <label>Persona:</label>
    ${(['', 'builder', 'strategist', 'newcomer'] as const).map((p) =>
      `<a href="?segment=${segment}&firstName=${encodeURIComponent(firstName || '')}&date=${editionDate}&persona=${p}" class="${(p || undefined) === personaCluster ? 'active' : ''}">${p || 'default'}</a>`
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
   * GET /digest/archive - Public archive of all sent editions of The Prompt
   * Must be registered BEFORE /:date to avoid "archive" matching as a date param
   */
  router.get('/archive', async (_req: Request, res: Response) => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    try {
      const digests = await getRecentDigests(50);
      const editions = digests
        .filter((d) => !isLegacyContent(d.content))
        .map((d) => {
          const date = new Date(d.edition_date).toISOString().split('T')[0];
          const subject = generateDigestSubject(d.content as DigestContent);
          return { date, subject, sentAt: d.sent_at };
        });

      const editionHtml = editions.map((e) => `
        <li style="margin-bottom: 12px;">
          <a href="/digest/${esc(e.date)}" style="color: #2563eb; text-decoration: none; font-weight: 600;">${esc(e.subject)}</a>
          <span style="color: #888; font-size: 13px; margin-left: 8px;">${new Date(e.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</span>
        </li>
      `).join('');

      res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Prompt — Archive</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f5f5f5; }
    .container { max-width: 640px; margin: 40px auto; padding: 20px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 24px; color: #1a1a2e; margin-bottom: 4px; }
    .subtitle { font-size: 14px; color: #666; margin-bottom: 24px; }
    ul { list-style: none; padding: 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>The Prompt</h1>
    <p class="subtitle">from Addie — Archive of all editions</p>
    <ul>${editionHtml || '<li style="color:#888;">No editions yet.</li>'}</ul>
    <p style="margin-top: 24px; text-align: center;"><a href="/" style="color: #2563eb; text-decoration: none;">← Back to AgenticAdvertising.org</a></p>
  </div>
</body>
</html>`);
    } catch (error) {
      logger.error({ error }, 'Failed to render digest archive');
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

      if (isLegacyContent(digest.content)) {
        res.status(410).send('This digest edition is no longer available in web format.');
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
