import { query } from './client.js';

export interface AgentTestRunInsert {
  workos_user_id: string;
  workos_organization_id?: string | null;
  agent_hostname?: string | null;
  agent_protocol?: 'mcp' | 'a2a' | 'rest' | null;
  test_kind: string;
  outcome: 'pass' | 'fail' | 'partial' | 'error';
  duration_ms?: number;
  storyboard_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentTestingContext {
  last_test_at: Date | null;
  total_tests_30d: number;
  last_outcome: 'pass' | 'fail' | 'partial' | 'error' | null;
}

export async function recordAgentTestRun(run: AgentTestRunInsert): Promise<void> {
  await query(
    `INSERT INTO agent_test_runs
       (workos_user_id, workos_organization_id, agent_hostname, agent_protocol,
        test_kind, outcome, duration_ms, storyboard_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      run.workos_user_id,
      run.workos_organization_id ?? null,
      run.agent_hostname ?? null,
      run.agent_protocol ?? null,
      run.test_kind,
      run.outcome,
      run.duration_ms ?? -1,
      run.storyboard_id ?? null,
      JSON.stringify(run.metadata ?? {}),
    ]
  );
}

export async function getAgentTestingContext(workosUserId: string): Promise<AgentTestingContext | null> {
  const result = await query<{
    last_test_at: Date | null;
    last_outcome: string | null;
    total_tests_30d: string;
  }>(
    `SELECT
       ran_at  AS last_test_at,
       outcome AS last_outcome,
       (SELECT COUNT(*)::int
          FROM agent_test_runs
         WHERE workos_user_id = $1
           AND ran_at > NOW() - INTERVAL '30 days') AS total_tests_30d
       FROM agent_test_runs
      WHERE workos_user_id = $1
      ORDER BY ran_at DESC
      LIMIT 1`,
    [workosUserId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    last_test_at: row.last_test_at,
    last_outcome: (row.last_outcome ?? null) as AgentTestingContext['last_outcome'],
    total_tests_30d: parseInt(row.total_tests_30d, 10),
  };
}
