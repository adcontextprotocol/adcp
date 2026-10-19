/** Real PostgreSQL reservation controls; no Google/WorkOS calls or live canary evidence. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {Pool} from 'pg';
import {initializeDatabase,closeDatabase} from '../../src/db/client.js';
import {runMigrations} from '../../src/db/migrate.js';
import {reserveTrainingGcsAccount} from '../../src/training-agent/gcs-reporting.js';

type Binding=Parameters<typeof reserveTrainingGcsAccount>[1];
const prefix='gcs_replacement_control_';
const principal='workos:gcs-replacement-control';
const schema='training_reporting_gcs';

describe('retired private reporting account replacement',()=>{
 let db:Pool;
 beforeAll(async()=>{
  const connectionString=process.env.DATABASE_URL||'postgresql://adcp:localdev@localhost:5432/adcp_test';
  const url=new URL(connectionString);
  if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/adcp_test')throw new Error('Replacement controls require local adcp_test');
  db=initializeDatabase({connectionString});await runMigrations();
 },120000);
 async function clear(){
  for(const table of ['host_grants','host_accounts','adcp_reporting_destination_authorizations']){
   await db.query(`DELETE FROM ${schema}.${table} WHERE left(account_id,length($1))=$1`,[prefix]);
  }
 }
 beforeEach(clear);
 afterAll(async()=>{if(db){try{await clear();}finally{await closeDatabase();}}});
 function binding(id:string,owner=principal):Binding{
  return {account_id:prefix+id,principal_id:owner,source_config_id:'source-'+id,source_config_version:1,
   destination_ref:'destination-'+id,currency:'USD',media_buy_ids:['mb_'+id],
   installed_input:{delivery_config_id:'gcs:source-'+id,delivery_config_version:1} as Binding['installed_input']};
 }
 async function authorize(input:Binding,generation=1,retired=false){
  await db.query(`INSERT INTO ${schema}.adcp_reporting_destination_authorizations(account_id,destination_ref,generation,authorized_at,revoked_at,data)
   VALUES($1,$2,$3,clock_timestamp(),CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,'{}')`,[input.account_id,input.destination_ref,generation,retired]);
 }
 async function grant(input:Binding,generation=1){
  await db.query(`INSERT INTO ${schema}.host_grants(account_id,destination_ref,generation,reader_grant)
   VALUES($1,$2,$3,'{}')`,[input.account_id,input.destination_ref,generation]);
 }
 async function revoke(input:Binding,generation=1){
  await db.query(`UPDATE ${schema}.adcp_reporting_destination_authorizations SET revoked_at=clock_timestamp()
   WHERE account_id=$1 AND destination_ref=$2 AND generation=$3`,[input.account_id,input.destination_ref,generation]);
 }
 async function accounts(){return(await db.query(`SELECT * FROM ${schema}.host_accounts WHERE left(account_id,length($1))=$1 ORDER BY account_id`,[prefix])).rows;}
 async function legacyInsert(input:Binding){
  await db.query(`INSERT INTO ${schema}.host_accounts
   (account_id,principal_id,source_config_id,source_config_version,destination_ref,currency,media_buy_ids,installed_input)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
  [input.account_id,input.principal_id,input.source_config_id,input.source_config_version,input.destination_ref,
   input.currency,JSON.stringify(input.media_buy_ids),input.installed_input]);
 }

 it('keeps the fence authoritative for concurrent older-runtime inserts during rollout',async()=>{
  const candidates=[binding('one'),binding('two')];
  const results=await Promise.allSettled(candidates.map(legacyInsert));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(result=>result.status==='rejected');
  expect(rejected?.status==='rejected'&&rejected.reason.code).toBe('23514');
  const before=await accounts();expect(before).toHaveLength(1);
  const winner=candidates.find(input=>input.account_id===before[0].account_id)!;
  const replacement=candidates.find(input=>input.account_id!==winner.account_id)!;
  await legacyInsert(winner);expect(await accounts()).toEqual(before);
  await authorize(winner);await grant(winner);
  await expect(legacyInsert(replacement)).rejects.toThrow('active or unfinished');
  await revoke(winner);await legacyInsert(replacement);
  expect((await accounts()).find(row=>row.account_id===winner.account_id)).toEqual(before[0]);
  await expect(legacyInsert(winner)).rejects.toThrow('destination is retired');
 });

 it('serializes competing first reservations and permits exact repair of the winner',async()=>{
  const candidates=[binding('one'),binding('two')];
  const results=await Promise.allSettled(candidates.map(input=>reserveTrainingGcsAccount(db,input)));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(result=>result.status==='rejected');
  expect(rejected?.status==='rejected'&&rejected.reason.code).toBe('VALIDATION_ERROR');
  const before=await accounts();expect(before).toHaveLength(1);
  await reserveTrainingGcsAccount(db,candidates.find(input=>input.account_id===before[0].account_id)!);
  expect(await accounts()).toEqual(before);
 });

 it('blocks another account while the first reservation is unfinished or authorized',async()=>{
  const first=binding('first'),next=binding('next');await reserveTrainingGcsAccount(db,first);
  await expect(reserveTrainingGcsAccount(db,next)).rejects.toThrow('active or unfinished');
  await authorize(first);await grant(first);
  await expect(reserveTrainingGcsAccount(db,next)).rejects.toThrow('active or unfinished');
  expect((await accounts()).map(row=>row.account_id)).toEqual([first.account_id]);
 });

 it('admits a replacement after exact revocation and preserves all original binding and tombstone bytes',async()=>{
  const first=binding('first'),next=binding('next');await reserveTrainingGcsAccount(db,first);
  await authorize(first);await grant(first);await revoke(first);
  const before=(await accounts())[0];
  const tombstone=(await db.query(`SELECT * FROM ${schema}.adcp_reporting_destination_authorizations WHERE account_id=$1`,[first.account_id])).rows;
  const oldGrant=(await db.query(`SELECT * FROM ${schema}.host_grants WHERE account_id=$1`,[first.account_id])).rows;
  await reserveTrainingGcsAccount(db,next);
  expect((await accounts()).find(row=>row.account_id===first.account_id)).toEqual(before);
  expect((await accounts()).map(row=>row.account_id)).toEqual([first.account_id,next.account_id]);
  expect((await db.query(`SELECT * FROM ${schema}.adcp_reporting_destination_authorizations WHERE account_id=$1`,[first.account_id])).rows).toEqual(tombstone);
  expect((await db.query(`SELECT * FROM ${schema}.host_grants WHERE account_id=$1`,[first.account_id])).rows).toEqual(oldGrant);
  await expect(reserveTrainingGcsAccount(db,first)).rejects.toThrow('destination is retired');
 });

 it('requires the exact grant generation to be revoked and rejects a newer current authorization',async()=>{
  const first=binding('first');await reserveTrainingGcsAccount(db,first);await authorize(first);await grant(first);
  await authorize(first,2,true);
  await expect(reserveTrainingGcsAccount(db,binding('next'))).rejects.toThrow('active or unfinished');
  await revoke(first);await authorize(first,3);
  await expect(reserveTrainingGcsAccount(db,binding('next'))).rejects.toThrow('active or unfinished');
 });

 it('does not treat an authorization without its saved host grant as retirement proof',async()=>{
  const first=binding('first');await reserveTrainingGcsAccount(db,first);await authorize(first);await revoke(first);
  await expect(reserveTrainingGcsAccount(db,binding('next'))).rejects.toThrow('active or unfinished');
 });

 it('preserves immutable source facts and rejects account ownership takeover',async()=>{
  const first=binding('first');await reserveTrainingGcsAccount(db,first);const before=await accounts();
  await expect(reserveTrainingGcsAccount(db,{...first,currency:'EUR'})).rejects.toThrow('immutable source facts');
  await expect(reserveTrainingGcsAccount(db,{...first,installed_input:{...first.installed_input,delivery_config_version:2}})).rejects.toThrow('immutable source facts');
  await expect(reserveTrainingGcsAccount(db,{...first,principal_id:'workos:another-owner'})).rejects.toThrow('immutable source facts');
  expect(await accounts()).toEqual(before);
 });

 it('keeps reservations for different organizations independent',async()=>{
  await reserveTrainingGcsAccount(db,binding('first'));await reserveTrainingGcsAccount(db,binding('other','workos:another-owner'));
  expect(await accounts()).toHaveLength(2);
 });

 it('does not leave advisory locks or partial reservations after rollback',async()=>{
  const first=binding('first');await reserveTrainingGcsAccount(db,first);
  await expect(reserveTrainingGcsAccount(db,binding('blocked'))).rejects.toThrow('active or unfinished');
  await authorize(first);await grant(first);await revoke(first);
  await reserveTrainingGcsAccount(db,binding('after-rollback'));
  expect((await accounts()).map(row=>row.account_id)).toEqual([prefix+'after-rollback',first.account_id]);
 });
});
