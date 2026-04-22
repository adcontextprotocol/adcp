/**
 * Escape user-controlled text before interpolating it into a Slack mrkdwn
 * block. Slack mrkdwn can't execute code, but it interprets `<!here>`,
 * `<!channel>`, and `<@USERID>` as pings — so a malicious submitter
 * embedding those strings in a title, excerpt, or member name could ping
 * the reviewer channel at submission time.
 *
 * Truncates the raw input to `maxLength` *first*, then escapes `&`, `<`,
 * `>`. Truncating first ensures `maxLength` caps the meaningful content —
 * not the expanded escape output — so an attacker can't flood the Slack
 * block by stuffing characters that balloon in size after escaping
 * (e.g. `<` → `&lt;` is a 4x expansion).
 */
export function escapeSlackText(raw: string, maxLength = 240): string {
  const truncated = raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw;
  return truncated
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
