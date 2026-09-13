import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initializeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  issueVoiceCallbackBinding,
  persistVoiceCallbackBinding,
  resolveVoiceCallback,
  VoiceAuthorizationUnavailableError,
} from '../../src/addie/voice-authorization.js';

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
});
