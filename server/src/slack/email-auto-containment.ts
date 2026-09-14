/** Stable policy outcome, distinct from a database or provider failure. */
export class SlackEmailAutoLinkContainedError extends Error {
  readonly code = 'slack_email_auto_linking_disabled' as const;

  constructor() {
    super('Automatic Slack identity linking by email is disabled');
    this.name = 'SlackEmailAutoLinkContainedError';
  }
}
