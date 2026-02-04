/**
 * Interaction Analyzer Service
 *
 * Analyzes emails and DMs to:
 * 1. Extract learnings about contacts/orgs (update CRM data)
 * 2. Manage tasks (complete, reschedule, or create new ones)
 *
 * Called after processing emails and Slack DMs to keep the CRM
 * and task system in sync with actual communications.
 */

import { createLogger } from '../../logger.js';
import { getPool } from '../../db/client.js';
import { isLLMConfigured, complete } from '../../utils/llm.js';

const logger = createLogger('interaction-analyzer');

/**
 * Context about the interaction being analyzed
 */
export interface InteractionContext {
  // Who initiated and who received
  fromEmail?: string;
  fromSlackUserId?: string;
  toEmails?: string[];

  // Content
  subject?: string;
  content: string;

  // What type of interaction
  channel: 'email' | 'slack_dm' | 'slack_channel';
  direction: 'inbound' | 'outbound';

  // Context about the contact/org
  contactId?: string;
  contactName?: string;
  organizationId?: string;
  organizationName?: string;

  // Who on our team is involved
  adminUserId?: string;
  adminName?: string;
}

/**
 * Result of analyzing an interaction
 */
export interface InteractionAnalysis {
  // Learnings to update on the contact/org
  learnings?: {
    interests?: string[];
    concerns?: string[];
    decisionTimeline?: string;
    budget?: string;
    otherNotes?: string;
  };

  // Task actions
  taskActions: TaskAction[];

  // Raw analysis for logging
  rawAnalysis: string;
}

/**
 * An action to take on tasks
 */
export interface TaskAction {
  action: 'complete' | 'reschedule' | 'create';

  // For complete/reschedule - which task
  existingTaskId?: number;
  existingTaskDescription?: string;

  // For reschedule/create - the new details
  newDescription?: string;
  newDueDate?: string; // ISO date string

  // Why this action
  reason: string;
}

/**
 * Pending task for a contact/org
 */
interface PendingTask {
  id: number;
  description: string;
  dueDate: Date | null;
  orgId: string;
  orgName: string;
  ownerUserId: string;
}

/**
 * Get pending tasks for a contact's organization
 */
async function getPendingTasksForOrg(orgId: string): Promise<PendingTask[]> {
  const pool = getPool();

  const result = await pool.query<{
    id: number;
    description: string;
    next_step_due_date: Date | null;
    organization_id: string;
    org_name: string;
    next_step_owner_user_id: string;
  }>(`
    SELECT
      oa.id,
      oa.description,
      oa.next_step_due_date,
      oa.organization_id,
      o.name as org_name,
      oa.next_step_owner_user_id
    FROM org_activities oa
    JOIN organizations o ON o.workos_organization_id = oa.organization_id
    WHERE oa.organization_id = $1
      AND oa.is_next_step = TRUE
      AND oa.next_step_completed_at IS NULL
    ORDER BY oa.next_step_due_date ASC NULLS LAST
  `, [orgId]);

  return result.rows.map(row => ({
    id: row.id,
    description: row.description,
    dueDate: row.next_step_due_date,
    orgId: row.organization_id,
    orgName: row.org_name,
    ownerUserId: row.next_step_owner_user_id,
  }));
}

/**
 * Get org ID from contact email domain
 */
async function getOrgIdFromEmail(email: string): Promise<{ orgId: string; orgName: string } | null> {
  const pool = getPool();
  const domain = email.split('@')[1]?.toLowerCase();

  if (!domain) return null;

  // Check organization_domains table first
  const domainResult = await pool.query<{ workos_organization_id: string; name: string }>(`
    SELECT od.workos_organization_id, o.name
    FROM organization_domains od
    JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
    WHERE od.domain = $1
    LIMIT 1
  `, [domain]);

  if (domainResult.rows.length > 0) {
    return { orgId: domainResult.rows[0].workos_organization_id, orgName: domainResult.rows[0].name };
  }

  // Fall back to email_domain on organizations
  const orgResult = await pool.query<{ workos_organization_id: string; name: string }>(`
    SELECT workos_organization_id, name
    FROM organizations
    WHERE email_domain = $1
      AND is_personal IS NOT TRUE
    LIMIT 1
  `, [domain]);

  if (orgResult.rows.length > 0) {
    return { orgId: orgResult.rows[0].workos_organization_id, orgName: orgResult.rows[0].name };
  }

  return null;
}

/**
 * System prompt for interaction analysis
 */
const ANALYSIS_PROMPT = `You are analyzing a business communication to help maintain a CRM and task management system.

Given the interaction content and any existing pending tasks, determine:

1. **Learnings**: What did we learn about this contact/company?
   - Interests (what they care about)
   - Concerns (objections, hesitations)
   - Decision timeline (when they might decide)
   - Budget signals
   - Other relevant notes

2. **Task Actions**: Based on this interaction, what should happen to tasks?
   - COMPLETE: If a pending task was essentially accomplished by this interaction
     (e.g., task was "follow up with X" and we just had a conversation with X)
   - RESCHEDULE: If a pending task should be moved to a different date
     (e.g., they said "ping me next month" or "I'm busy until March")
   - CREATE: If a new follow-up was mentioned or committed to
     (e.g., "let's schedule a call next week" or "send me the pricing")

Respond in JSON format:
{
  "learnings": {
    "interests": ["interest1", "interest2"],
    "concerns": ["concern1"],
    "decisionTimeline": "Q2 2024" or null,
    "budget": "$X-Y range" or null,
    "otherNotes": "any other relevant info" or null
  },
  "taskActions": [
    {
      "action": "complete" | "reschedule" | "create",
      "existingTaskId": 123,  // for complete/reschedule
      "existingTaskDescription": "the task being modified",  // for context
      "newDescription": "what needs to be done",  // for reschedule/create
      "newDueDate": "2024-02-15",  // ISO date for reschedule/create
      "reason": "why this action"
    }
  ]
}

Important:
- Only include taskActions that are clearly indicated by the conversation
- For COMPLETE, be conservative - only mark complete if the task was genuinely addressed
- For CREATE, only create tasks for concrete commitments, not vague intentions
- Dates should be reasonable business dates (weekdays, not holidays)
- If no task actions are warranted, return an empty taskActions array`;

/**
 * Analyze an interaction and determine task actions
 */
export async function analyzeInteraction(
  context: InteractionContext
): Promise<InteractionAnalysis | null> {
  if (!isLLMConfigured()) {
    logger.warn('Anthropic not configured, skipping interaction analysis');
    return null;
  }

  // Get org context from email if not provided
  let orgId = context.organizationId;
  let orgName = context.organizationName;

  if (!orgId && context.fromEmail) {
    const orgInfo = await getOrgIdFromEmail(context.fromEmail);
    if (orgInfo) {
      orgId = orgInfo.orgId;
      orgName = orgInfo.orgName;
    }
  }

  if (!orgId && context.toEmails?.length) {
    for (const email of context.toEmails) {
      const orgInfo = await getOrgIdFromEmail(email);
      if (orgInfo) {
        orgId = orgInfo.orgId;
        orgName = orgInfo.orgName;
        break;
      }
    }
  }

  // Get pending tasks for context
  let pendingTasks: PendingTask[] = [];
  if (orgId) {
    pendingTasks = await getPendingTasksForOrg(orgId);
  }

  // Build the prompt
  let prompt = `## Interaction Details\n`;
  prompt += `Channel: ${context.channel}\n`;
  prompt += `Direction: ${context.direction}\n`;
  if (context.fromEmail) prompt += `From: ${context.fromEmail}\n`;
  if (context.toEmails?.length) prompt += `To: ${context.toEmails.join(', ')}\n`;
  if (context.subject) prompt += `Subject: ${context.subject}\n`;
  if (orgName) prompt += `Organization: ${orgName}\n`;
  if (context.contactName) prompt += `Contact: ${context.contactName}\n`;
  prompt += `\n## Content\n${context.content.substring(0, 3000)}\n`;

  if (pendingTasks.length > 0) {
    prompt += `\n## Pending Tasks for ${orgName || 'this contact'}\n`;
    for (const task of pendingTasks) {
      const dueStr = task.dueDate
        ? `due ${task.dueDate.toISOString().split('T')[0]}`
        : 'no due date';
      prompt += `- [ID: ${task.id}] ${task.description} (${dueStr})\n`;
    }
  } else {
    prompt += `\n## Pending Tasks\nNo pending tasks for this contact/organization.\n`;
  }

  try {
    const result = await complete({
      prompt,
      system: ANALYSIS_PROMPT,
      maxTokens: 1000,
      model: 'fast',
      operationName: 'interaction-analysis',
    });

    // Parse the JSON response
    const rawAnalysis = result.text;
    let parsed: {
      learnings?: InteractionAnalysis['learnings'];
      taskActions?: Array<{
        action: string;
        existingTaskId?: number;
        existingTaskDescription?: string;
        newDescription?: string;
        newDueDate?: string;
        reason: string;
      }>;
    };

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = rawAnalysis.match(/```json\s*([\s\S]*?)\s*```/) ||
                        rawAnalysis.match(/```\s*([\s\S]*?)\s*```/) ||
                        [null, rawAnalysis];
      parsed = JSON.parse(jsonMatch[1] || rawAnalysis);
    } catch (parseError) {
      logger.warn({ parseError, rawAnalysis: rawAnalysis.substring(0, 500) },
        'Failed to parse interaction analysis JSON');
      return null;
    }

    const taskActions: TaskAction[] = (parsed.taskActions || [])
      .filter(ta => ['complete', 'reschedule', 'create'].includes(ta.action))
      .map(ta => ({
        action: ta.action as 'complete' | 'reschedule' | 'create',
        existingTaskId: ta.existingTaskId,
        existingTaskDescription: ta.existingTaskDescription,
        newDescription: ta.newDescription,
        newDueDate: ta.newDueDate,
        reason: ta.reason,
      }));

    logger.info({
      durationMs: result.latencyMs,
      orgId,
      orgName,
      pendingTaskCount: pendingTasks.length,
      taskActionCount: taskActions.length,
      hasLearnings: !!parsed.learnings,
      tokensUsed: (result.inputTokens || 0) + (result.outputTokens || 0),
    }, 'Interaction analysis completed');

    return {
      learnings: parsed.learnings,
      taskActions,
      rawAnalysis,
    };
  } catch (error) {
    logger.error({ error }, 'Error analyzing interaction');
    return null;
  }
}

/**
 * Apply task actions from an analysis
 */
export async function applyTaskActions(
  analysis: InteractionAnalysis,
  adminUserId?: string,
  adminName?: string
): Promise<{
  completed: number;
  rescheduled: number;
  created: number;
  errors: number;
}> {
  const pool = getPool();
  const results = { completed: 0, rescheduled: 0, created: 0, errors: 0 };

  for (const action of analysis.taskActions) {
    try {
      switch (action.action) {
        case 'complete': {
          // Validate existingTaskId is a valid integer
          if (!action.existingTaskId || !Number.isInteger(action.existingTaskId) || action.existingTaskId <= 0) {
            logger.warn({ action }, 'Complete action has invalid existingTaskId');
            results.errors++;
            continue;
          }

          await pool.query(`
            UPDATE org_activities
            SET next_step_completed_at = NOW(),
                next_step_completed_reason = $2
            WHERE id = $1
              AND is_next_step = TRUE
              AND next_step_completed_at IS NULL
          `, [action.existingTaskId, `Auto-completed: ${action.reason}`]);

          logger.info({
            taskId: action.existingTaskId,
            reason: action.reason
          }, 'Auto-completed task based on interaction');

          results.completed++;
          break;
        }

        case 'reschedule': {
          // Validate existingTaskId is a valid integer
          if (!action.existingTaskId || !Number.isInteger(action.existingTaskId) || action.existingTaskId <= 0) {
            logger.warn({ action }, 'Reschedule action has invalid existingTaskId');
            results.errors++;
            continue;
          }

          const newDate = action.newDueDate ? new Date(action.newDueDate) : null;
          const newDesc = action.newDescription;

          await pool.query(`
            UPDATE org_activities
            SET next_step_due_date = COALESCE($2, next_step_due_date),
                description = COALESCE($3, description)
            WHERE id = $1
              AND is_next_step = TRUE
              AND next_step_completed_at IS NULL
          `, [action.existingTaskId, newDate?.toISOString().split('T')[0], newDesc]);

          logger.info({
            taskId: action.existingTaskId,
            newDate: newDate?.toISOString().split('T')[0],
            newDesc,
            reason: action.reason
          }, 'Rescheduled task based on interaction');

          results.rescheduled++;
          break;
        }

        case 'create': {
          if (!action.newDescription) {
            logger.warn({ action }, 'Create action missing newDescription');
            results.errors++;
            continue;
          }

          // Creating new tasks requires org context which we don't have in this flow
          // Log the suggested task for manual review
          logger.info({
            description: action.newDescription,
            dueDate: action.newDueDate,
            reason: action.reason,
          }, 'Suggested new task from interaction analysis (not auto-created)');

          // Don't increment created counter since task was not actually created
          // The LLM suggested a task but we can't create it without org context
          break;
        }
      }
    } catch (error) {
      logger.error({ error, action }, 'Error applying task action');
      results.errors++;
    }
  }

  return results;
}

/**
 * Full interaction processing: analyze and apply actions
 */
export async function processInteraction(
  context: InteractionContext
): Promise<{
  analyzed: boolean;
  analysis?: InteractionAnalysis;
  actionsApplied?: {
    completed: number;
    rescheduled: number;
    created: number;
    errors: number;
  };
}> {
  const analysis = await analyzeInteraction(context);

  if (!analysis) {
    return { analyzed: false };
  }

  if (analysis.taskActions.length === 0) {
    logger.debug('No task actions from interaction analysis');
    return { analyzed: true, analysis };
  }

  const actionsApplied = await applyTaskActions(
    analysis,
    context.adminUserId,
    context.adminName
  );

  return { analyzed: true, analysis, actionsApplied };
}
