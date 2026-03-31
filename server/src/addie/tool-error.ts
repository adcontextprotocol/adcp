/**
 * Thrown by tool handlers for expected failures (validation, not found, API errors).
 * Distinguished from unexpected errors in the catch block: ToolError skips Slack
 * escalation, while unexpected errors still escalate.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
