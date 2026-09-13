import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initializeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  deriveVoiceCallbackTurnId,
  issueVoiceCallbackBinding,
  persistVoiceCallbackBinding,
  resolveVoiceCallback,
  VoiceAuthorizationUnavailableError,
} from '../../src/addie/voice-authorization.js';
import { ThreadService } from '../../src/addie/thread-service.js';

const THREAD_ID = '74500000-0000-4000-8000-000000000001';
const EXTERNAL_ID = `addie-${THREAD_ID}`;
const previousSecret = process.env.TAVUS_LLM_SECRET;
const originalProvenance = { version: 1, authenticated_workos_user_id: 'voice_exact_credential', authorization_fingerprint: 'voice_exact_credential:1' };

async function removeNoopTrigger(): Promise<void> {
  await query('DROP TRIGGER IF EXISTS voice_callback_test_noop ON addie_threads');
  await query('DROP FUNCTION IF EXISTS voice_callback_test_noop()');
}

async function installNoopTrigger(): Promise<void> {
  await query(`CREATE FUNCTION voice_callback_test_noop() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.thread_id = '${THREAD_ID}'::uuid THEN RETURN NULL; END IF;
      RETURN NEW;
    END $$`);
  await query('CREATE TRIGGER voice_callback_test_noop BEFORE UPDATE ON addie_threads FOR EACH ROW EXECUTE FUNCTION voice_callback_test_noop()');
}

describe('primary-database voice callback binding writes', () => {
  beforeAll(async () => {
    initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
    process.env.TAVUS_LLM_SECRET = 'voice-callback-integration-secret';
  }, 60_000);

  beforeEach(async () => {
    await removeNoopTrigger();
    await query('DELETE FROM addie_threads WHERE thread_id = $1', [THREAD_ID]);
    await query(`INSERT INTO addie_threads (thread_id, channel, external_id, user_type, user_id, context)
      VALUES ($1, 'video', $2, 'workos', 'voice_canonical_identity', $3::jsonb)`,
    [THREAD_ID, EXTERNAL_ID, JSON.stringify({ voice_authorization: originalProvenance })]);
  });

  afterEach(removeNoopTrigger);
  afterAll(async () => {
    await removeNoopTrigger();
    await query('DELETE FROM addie_threads WHERE thread_id = $1', [THREAD_ID]);
    await closeDatabase();
    if (previousSecret === undefined) delete process.env.TAVUS_LLM_SECRET;
    else process.env.TAVUS_LLM_SECRET = previousSecret;
  });

  it('commits a grant and revocation through bounded write transactions without changing exact credential provenance', async () => {
    const issued = issueVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, 60);
    await persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, issued.binding);
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'invalid' });
    await persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, issued.binding, 'provider-conversation');
    await expect(resolveVoiceCallback(issued.token)).resolves.toMatchObject({ status: 'verified', thread: { thread_id: THREAD_ID } });
    await persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, null);
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'invalid' });
    const result = await query('SELECT context FROM addie_threads WHERE thread_id = $1', [THREAD_ID]);
    expect(result.rows[0].context.voice_callback_binding).toBeNull();
    expect(result.rows[0].context.voice_authorization).toEqual(originalProvenance);
  });

  it('rejects silent no-op grant and revocation writes instead of reporting success', async () => {
    const issued = issueVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, 60);
    await installNoopTrigger();
    await expect(persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, issued.binding))
      .rejects.toBeInstanceOf(VoiceAuthorizationUnavailableError);
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'invalid' });

    await removeNoopTrigger();
    await persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, issued.binding);
    await persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, issued.binding, 'provider-conversation');
    await installNoopTrigger();
    await expect(persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, null))
      .rejects.toBeInstanceOf(VoiceAuthorizationUnavailableError);
    const result = await query('SELECT context FROM addie_threads WHERE thread_id = $1', [THREAD_ID]);
    expect(result.rows[0].context.voice_callback_binding.nonce).toBe(issued.binding.nonce);
  });

  it('does not restore a capability if provider session creation finishes after local revocation', async () => {
    const issued = issueVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, 60);
    await persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, issued.binding);
    await persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, null);
    await expect(persistVoiceCallbackBinding(THREAD_ID, EXTERNAL_ID, issued.binding, 'late-provider-conversation'))
      .rejects.toBeInstanceOf(VoiceAuthorizationUnavailableError);
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'invalid' });
  });

  it('serializes concurrent callback claims across independent service instances and persists one completion receipt', async () => {
    const replicaA = new ThreadService();
    const replicaB = new ThreadService();
    const clientTurnId = deriveVoiceCallbackTurnId({ threadId: THREAD_ID, externalId: EXTERNAL_ID, providerConversationId: 'provider-conversation', messages: [
      { role: 'system', content: '[conductor:voice_session]' },
      { role: 'user', content: 'Perform this callback once.' },
    ] });

    const claims = await Promise.all([
      replicaA.claimClientTurn(THREAD_ID, clientTurnId, false),
      replicaB.claimClientTurn(THREAD_ID, clientTurnId, false),
    ]);
    expect(claims.map((claim) => claim.state).sort()).toEqual(['claimed', 'processing']);
    const winner = claims.find((claim) => claim.state === 'claimed');
    expect(winner?.leaseId).toBeTruthy();

    await replicaA.addMessage({
      thread_id: THREAD_ID,
      role: 'user',
      content: 'Perform this callback once.',
      client_request_id: clientTurnId,
      message_source: 'voice',
    });
    await replicaB.addMessage({
      thread_id: THREAD_ID,
      role: 'assistant',
      content: 'Completed once.',
      client_request_id: clientTurnId,
      delivery_status: 'completed',
      client_turn_lease_id: winner!.leaseId,
      finalize_client_turn_status: 'completed',
    });

    await expect(new ThreadService().claimClientTurn(THREAD_ID, clientTurnId, false))
      .resolves.toEqual({ state: 'completed' });
    const receipt = await replicaA.getMessagesByClientRequestId(THREAD_ID, clientTurnId);
    expect(receipt.filter((message) => message.role === 'assistant' && message.delivery_status === 'completed')).toHaveLength(1);
  });

  it('allows an independent service instance to reclaim a callback only after an interrupted attempt', async () => {
    const replicaA = new ThreadService();
    const replicaB = new ThreadService();
    const clientTurnId = deriveVoiceCallbackTurnId({ threadId: THREAD_ID, externalId: EXTERNAL_ID, providerConversationId: 'provider-conversation', messages: [
      { role: 'system', content: '[conductor:voice_session]' },
      { role: 'user', content: 'Retry after failure.' },
    ] });
    const first = await replicaA.claimClientTurn(THREAD_ID, clientTurnId, false);
    expect(first.state).toBe('claimed');
    await replicaA.setClientTurnStatus(THREAD_ID, clientTurnId, first.leaseId!, 'interrupted');

    await expect(replicaB.claimClientTurn(THREAD_ID, clientTurnId, false))
      .resolves.toEqual({ state: 'not_retryable' });
    await expect(replicaB.claimClientTurn(THREAD_ID, clientTurnId, true))
      .resolves.toMatchObject({ state: 'claimed', leaseId: expect.any(String) });
  });

  it('lets an independent replica reclaim an expired processing lease without stealing a live lease', async () => {
    const replicaA = new ThreadService();
    const replicaB = new ThreadService();
    const clientTurnId = deriveVoiceCallbackTurnId({ threadId: THREAD_ID, externalId: EXTERNAL_ID, providerConversationId: 'provider-conversation', messages: [
      { role: 'system', content: '[conductor:voice_session]' },
      { role: 'user', content: 'Recover the crashed callback.' },
    ] });
    const first = await replicaA.claimClientTurn(THREAD_ID, clientTurnId, false);
    expect(first.state).toBe('claimed');
    await expect(replicaB.claimClientTurn(THREAD_ID, clientTurnId, true))
      .resolves.toEqual({ state: 'processing' });

    await query(
      `UPDATE addie_chat_turns SET lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE thread_id = $1 AND client_request_id = $2`,
      [THREAD_ID, clientTurnId],
    );
    await expect(replicaB.claimClientTurn(THREAD_ID, clientTurnId, false))
      .resolves.toEqual({ state: 'processing' });
    await expect(replicaB.claimClientTurn(THREAD_ID, clientTurnId, true))
      .resolves.toMatchObject({ state: 'claimed', leaseId: expect.any(String) });
  });
});
