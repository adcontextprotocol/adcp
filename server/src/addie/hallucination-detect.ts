/**
 * Hallucination detection for Addie responses.
 * Extracted to a standalone module for testability.
 */

export interface ToolExecutionRecord {
  tool_name: string;
  is_error: boolean;
}

/**
 * Action-claiming patterns mapped to the tools that should back them up.
 * A pattern fires when the response text matches but no expected tool succeeded.
 */
export const HALLUCINATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; expectedTools: string[] }> = [
  { pattern: /invoice\s+(?:resent|sent)\s+successfully/i, expectedTools: ['resend_invoice', 'send_invoice', 'send_payment_request'] },
  { pattern: /(?:successfully\s+)?resent\s+(?:the\s+)?invoice/i, expectedTools: ['resend_invoice', 'send_invoice', 'send_payment_request'] },
  { pattern: /(?:billing\s+)?email\s+(?:updated|changed)\s+successfully/i, expectedTools: ['update_billing_email'] },
  { pattern: /(?:I'?ve\s+|I\s+)?resolved\s+(?:the\s+)?escalation/i, expectedTools: ['resolve_escalation'] },
  { pattern: /escalation\s+#?\d+\s+(?:has been\s+)?resolved/i, expectedTools: ['resolve_escalation'] },
  { pattern: /meeting\s+(?:scheduled|created)\s+successfully/i, expectedTools: ['schedule_meeting'] },
  { pattern: /(?:I'?ve\s+|I\s+)?(?:created|generated|sent)\s+(?:a\s+)?payment\s+link/i, expectedTools: ['create_payment_link'] },
  { pattern: /(?:I'?ve\s+|I\s+)?(?:sent|delivered)\s+(?:a\s+)?(?:DM|direct message|notification)/i, expectedTools: ['send_member_dm', 'resolve_escalation'] },
  { pattern: /(?:I'?ve\s+|I\s+)?added\s+\S+(?:\s+\S+){0,5}\s+to\s+the\s+(?:meeting|call|series)/i, expectedTools: ['add_meeting_attendee'] },
  // Escalation / ticket-creation claims — #3720
  { pattern: /(?:I'?ve\s+|I\s+)?(?:created|opened|filed|submitted)\s+(?:an?\s+)?(?:ticket|issue)(?:\s+#?\d+)?/i, expectedTools: ['escalate_to_admin', 'create_github_issue'] },
  { pattern: /(?:I'?ve\s+|I\s+)(?:notified|alerted)\s+(?:the\s+)?team|(?:the\s+)?team\s+has\s+been\s+notified\b/i, expectedTools: ['escalate_to_admin', 'send_member_dm'] },
  { pattern: /I'?ve\s+(?:flagged|escalated)\s+(?:this|the\s+(?:issue|matter|request|team))|I'?ve\s+notified\s+the\s+team/i, expectedTools: ['escalate_to_admin', 'send_member_dm'] },
];

/**
 * Detect possible hallucinated actions in response text.
 * Returns a flag reason if the text claims to have completed an action
 * but no corresponding tool was actually called AND succeeded.
 */
export function detectHallucinatedAction(text: string, toolExecutions: ToolExecutionRecord[]): string | null {
  for (const { pattern, expectedTools } of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      const hasSuccessfulTool = expectedTools.some(t =>
        toolExecutions.some(exec => exec.tool_name === t && !exec.is_error)
      );
      if (!hasSuccessfulTool) {
        return `Possible hallucinated action: text matches "${pattern.source}" but none of [${expectedTools.join(', ')}] succeeded`;
      }
    }
  }
  return null;
}
