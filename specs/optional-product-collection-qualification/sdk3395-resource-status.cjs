const assert = require('node:assert/strict');
const {runStoryboard}=require('@adcp/sdk/testing');
const tools=['get_adcp_capabilities','create_media_buy','get_media_buys'];
const caps={status:'completed',adcp:{major_versions:[3],supported_versions:['3.2'],idempotency:{supported:false}},supported_protocols:['media_buy'],media_buy:{buying_modes:['wholesale']}};
const account={brand:{domain:'acmeoutdoor.example'},operator:'pinnacle-agency.example',sandbox:true};
const doc={id:'media_buy_seller/status_identity_probe',version:'1.0.0',title:'Task status is not resource lifecycle',category:'media_buy_seller',required_tools:['create_media_buy'],phases:[{id:'lifecycle',title:'Create then read',steps:[
 {id:'create',title:'Create',task:'create_media_buy',stateful:true,schema_ref:'media-buy/create-media-buy-request.json',response_schema_ref:'media-buy/create-media-buy-response.json',sample_request:{brand:account.brand,account,idempotency_key:'status-probe-create',start_time:'asap',end_time:'2099-09-30T23:59:59Z',packages:[{product_id:'seller-product',pricing_option_id:'seller-price',budget:1000}]},context_outputs:[{key:'buy_id',path:'media_buy_id'}],validations:[{check:'response_schema',description:'Canonical create schema'}]},
 {id:'read',title:'Read',task:'get_media_buys',stateful:true,schema_ref:'media-buy/get-media-buys-request.json',response_schema_ref:'media-buy/get-media-buys-response.json',sample_request:{account,media_buy_ids:['$context.buy_id']},validations:[{check:'response_schema',description:'Canonical read schema'}]},
]}]};
async function run(includeLifecycle){
 const exchanges=[];
 const trustedFetchFn=async(_url,init={})=>{
  if(!init.body)return new Response(null,{status:init.method==='DELETE'?202:405});
  const msg=JSON.parse(init.body);let result;
  if(msg.method==='server/discover')return new Response(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Not supported'}}),{headers:{'content-type':'application/json'}});
  if(msg.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'status-control',version:'1'}};
  else if(msg.method.startsWith('notifications/'))return new Response(null,{status:202});
  else if(msg.method==='tools/list')result={tools:tools.map(name=>({name,description:name,inputSchema:{type:'object',additionalProperties:true}}))};
  else if(msg.method==='tools/call'){
   const task=msg.params.name;let data;
   if(task==='get_adcp_capabilities')data=caps;
   else if(task==='create_media_buy')data={status:'completed',...(includeLifecycle?{media_buy_status:'active'}:{}),media_buy_id:'seller-buy',confirmed_at:'2026-10-23T00:00:00Z',revision:1,packages:[{package_id:'seller-package',product_id:'seller-product'}]};
   else if(task==='get_media_buys')data={status:'completed',media_buys:[{media_buy_id:'seller-buy',status:'active',currency:'EUR',total_budget:1000,confirmed_at:'2026-10-23T00:00:00Z',revision:1,packages:[{package_id:'seller-package',product_id:'seller-product'}]}]};
   else throw Error('Unexpected task '+task);
   exchanges.push({task,request:msg.params.arguments,response:data});result={content:[{type:'text',text:JSON.stringify(data)}]};
  }else throw Error('Unexpected method '+msg.method);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}),{headers:{'content-type':'application/json'}});
 };
 const result=await runStoryboard('https://status-control.example/mcp',doc,{adcpVersion:'3.2.5',brand:account.brand,sandbox:true,timeout_ms:3000,profile:{tools,raw_capabilities:caps,supported_protocols:['media_buy']},transport:{trustedFetchFn}});
 console.log(JSON.stringify({includeLifecycle,overall_passed:result.overall_passed,failed_count:result.failed_count,exchanges,steps:result.phases.flatMap(p=>p.steps.map(s=>({id:s.step_id,passed:s.passed,validations:s.validations})))}));
 return result;
}
(async()=>{
 assert.equal((await run(true)).overall_passed,true,'explicit lifecycle positive control');
 assert.equal((await run(false)).overall_passed,true,'MAY omit lifecycle: task completed cannot establish terminal media-buy lifecycle');
})().catch(error=>{console.error(error);process.exitCode=1;});
