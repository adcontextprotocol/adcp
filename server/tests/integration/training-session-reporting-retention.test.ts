import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {structuredSerialize} from '@adcp/sdk/server';
import {initializeDatabase,closeDatabase} from '../../src/db/client.js';
import {runMigrations} from '../../src/db/migrate.js';
import {cleanupExpiredSessions,getSession,runWithSessionContext,setStateStore} from '../../src/training-agent/state.js';

const prefix='session_reporting_retention_test_';
const principal='workos:org-session-reporting-retention-test';
describe('reporting business state survives sandbox replay expiry',()=>{
 let pool:Pool;
 beforeAll(async()=>{
  pool=initializeDatabase({connectionString:process.env.DATABASE_URL||'postgresql://adcp:localdev@localhost:5432/adcp_test'});
  await runMigrations();setStateStore(null);
 },120000);
 async function clearFixtures(){
  await pool.query('DELETE FROM training_reporting_gcs.host_grants WHERE account_id LIKE $1',[prefix+'%']);
  await pool.query('DELETE FROM training_reporting_gcs.host_accounts WHERE account_id LIKE $1',[prefix+'%']);
  await pool.query('DELETE FROM training_reporting_gcs.adcp_reporting_destination_authorizations WHERE account_id LIKE $1',[prefix+'%']);
  await pool.query('DELETE FROM adcp_state WHERE collection=$1 AND id LIKE $2',['training_sessions',prefix+'%']);
 }
 beforeEach(async()=>{
  await clearFixtures();
  vi.stubEnv('TRAINING_REPORTING_GCS_ENABLED','true');
  vi.stubEnv('TRAINING_REPORTING_GCS_BUCKET','session-retention-fixture');
  vi.stubEnv('TRAINING_REPORTING_GCS_NAMESPACE','session-retention-fixture');
  vi.stubEnv('TRAINING_REPORTING_GCS_CREDENTIALS_FILE','/tmp/session-retention-fixture.json');
  vi.stubEnv('TRAINING_REPORTING_GCS_CANARY_PRINCIPAL',principal);
  vi.stubEnv('TRAINING_REPORTING_GCS_FRESH_BUCKET_ACK','true');
 });
 afterEach(()=>vi.unstubAllEnvs());
 afterAll(async()=>{await clearFixtures();await closeDatabase();});

 async function session(suffix:string,mediaBuyId:string,ageHours=36,malformed=false){
  const data=malformed?{mediaBuys:{__adcpType:'Map',entries:{invalid:true}}}:structuredSerialize({mediaBuys:new Map([[mediaBuyId,{mediaBuyId}]]),lastAccessedAt:new Date()});
  await pool.query('INSERT INTO adcp_state(collection,id,data,updated_at) VALUES($1,$2,$3::jsonb,now()-($4::int*interval \'1 hour\'))',['training_sessions',prefix+suffix,JSON.stringify(data),ageHours]);
 }
 async function destination(mediaBuyId:string,owner=principal){
  const accountId=prefix+mediaBuyId;
  await pool.query('INSERT INTO training_reporting_gcs.host_accounts(account_id,principal_id,source_config_id,source_config_version,destination_ref,currency,media_buy_ids,installed_input) VALUES($1,$2,$3,1,$4,\'USD\',$5::jsonb,\'{}\')',[accountId,owner,'source-fixture','destination-fixture',JSON.stringify([mediaBuyId])]);
  await pool.query('INSERT INTO training_reporting_gcs.adcp_reporting_destination_authorizations(account_id,destination_ref,generation,authorized_at,data) VALUES($1,$2,1,now()-interval \'36 hours\',\'{}\')',[accountId,'destination-fixture']);
  await pool.query('INSERT INTO training_reporting_gcs.host_grants(account_id,destination_ref,generation,reader_grant) VALUES($1,$2,1,\'{}\')',[accountId,'destination-fixture']);
  return accountId;
 }
 async function cleanup(){await cleanupExpiredSessions();}
 async function rows(){return(await pool.query('SELECT id,data,updated_at FROM adcp_state WHERE collection=$1 AND id LIKE $2 ORDER BY id',['training_sessions',prefix+'%'])).rows;}

 it('preserves an authorized daily source after 36 hours without refreshing its mutation timestamp',async()=>{
  await destination('mb_daily');await session('daily','mb_daily');await session('ordinary','mb_other');await session('recent','mb_recent',1);
  const original=(await rows()).find(row=>row.id===prefix+'daily');
  await cleanup();
  expect((await rows()).map(row=>row.id)).toEqual([prefix+'daily',prefix+'recent']);
  expect((await rows()).find(row=>row.id===prefix+'daily')).toEqual(original);
  await runWithSessionContext(async()=>expect((await getSession(prefix+'daily')).mediaBuys.has('mb_daily')).toBe(true));
 });

 it('releases the old source session after revocation while preserving its authorization tombstone',async()=>{
  const account=await destination('mb_revoked');await session('revoked','mb_revoked');
  await pool.query('UPDATE training_reporting_gcs.adcp_reporting_destination_authorizations SET revoked_at=now() WHERE account_id=$1',[account]);
  await cleanup();expect(await rows()).toEqual([]);
  expect((await pool.query('SELECT revoked_at FROM training_reporting_gcs.adcp_reporting_destination_authorizations WHERE account_id=$1',[account])).rows[0].revoked_at).not.toBeNull();
 });

 it('uses the exact authorization generation and preserves other legitimately bound accounts',async()=>{
  const account=await destination('mb_old');await session('old','mb_old');
  await pool.query('UPDATE training_reporting_gcs.adcp_reporting_destination_authorizations SET revoked_at=now() WHERE account_id=$1',[account]);
  await pool.query('INSERT INTO training_reporting_gcs.adcp_reporting_destination_authorizations(account_id,destination_ref,generation,authorized_at,data) VALUES($1,$2,2,now(),\'{}\')',[account,'destination-fixture']);
  await destination('mb_foreign','workos:org-other-retention-test');await session('foreign','mb_foreign');
  await session('unbound','mb_unbound');
  await cleanup();expect((await rows()).map(row=>row.id)).toEqual([prefix+'foreign']);
 });

 it('preserves a bound source when reporting delivery is paused',async()=>{
  await destination('mb_paused');await session('paused','mb_paused');
  vi.stubEnv('TRAINING_REPORTING_GCS_ENABLED','false');
  await cleanup();expect((await rows()).map(row=>row.id)).toEqual([prefix+'paused']);
 });

 it('cleans corrupt map shapes without aborting the whole cleanup pass',async()=>{
  await destination('mb_daily');await session('daily','mb_daily');await session('malformed','mb_daily',36,true);
  await cleanup();expect((await rows()).map(row=>row.id)).toEqual([prefix+'daily']);
 });
});
