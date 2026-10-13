import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const {query}=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../../src/db/client.js',()=>({isDatabaseInitialized:()=>true,getPool:()=>({query})}));
import {cleanupExpiredSessions} from '../../src/training-agent/state.js';

describe('private reporting session retention',()=>{
 beforeEach(()=>{query.mockReset();query.mockResolvedValueOnce({rows:[{reporting_grants:null}]}).mockResolvedValueOnce({rowCount:2});vi.stubEnv('TRAINING_REPORTING_GCS_ENABLED','false');});
 afterEach(()=>vi.unstubAllEnvs());

 it('keeps ordinary sandbox cleanup independent of the optional reporting schema',async()=>{
  expect(await cleanupExpiredSessions()).toBe(2);
  const [sql,params]=query.mock.calls[1];
  expect(sql).not.toContain('training_reporting_gcs');
  expect(params).toHaveLength(2);
  expect(params[0]).toBe('training_sessions');
  expect(params[1]).toBeInstanceOf(Date);
 });

 it('preserves durable authorizations when the runtime reporting flag is disabled',async()=>{
  query.mockReset();query.mockResolvedValueOnce({rows:[{reporting_grants:'training_reporting_gcs.host_grants'}]}).mockResolvedValueOnce({rowCount:0});
  expect(await cleanupExpiredSessions()).toBe(0);
  expect(query.mock.calls[1][0]).toContain('auth.revoked_at IS NULL');
  expect(query.mock.calls[1][0]).toContain('auth.generation = destination_grant.generation');
 });

 it('propagates a failed authoritative cleanup instead of reporting success',async()=>{
  query.mockReset();query.mockRejectedValue(new Error('primary unavailable'));
  await expect(cleanupExpiredSessions()).rejects.toThrow('primary unavailable');
  expect(query).toHaveBeenCalledTimes(1);
 });

 it('does not interpret an incomplete schema probe as permission to delete',async()=>{
  query.mockReset();query.mockResolvedValueOnce({rows:[]});
  await expect(cleanupExpiredSessions()).rejects.toThrow('Training session state is temporarily unavailable');
  expect(query).toHaveBeenCalledTimes(1);
 });
});
