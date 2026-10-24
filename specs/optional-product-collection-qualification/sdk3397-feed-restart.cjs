const assert = require('node:assert/strict');
const {prepareStoryboardFixtures:runStoryboard}=require('@adcp/sdk/testing');
const tools=['get_adcp_capabilities','get_products','create_media_buy','get_media_buys'];
const caps={status:'completed',adcp:{major_versions:[3],supported_versions:['3.2'],idempotency:{supported:false}},supported_protocols:['media_buy'],media_buy:{buying_modes:['wholesale']}};
const account={brand:{domain:'acmeoutdoor.example'},operator:'pinnacle-agency.example',sandbox:true};
const offer={product_id:'seller-product',name:'StreamHaus offer',description:'Sandbox',delivery_type:'non_guaranteed',channels:['olv'],publisher_properties:[{publisher_domain:'studio.example',selection_type:'all'}],format_options:[{format_option_id:'image',format_kind:'image',params:{width:300,height:250}}],reporting_capabilities:{available_reporting_frequencies:['daily'],expected_delay_minutes:0,timezone:'UTC',supports_webhooks:false,available_metrics:['impressions'],date_range_support:'date_range'},collections:[{publisher_domain:'studio.example',collection_ids:['a','b']}],collection_targeting_allowed:true,pricing_options:[{pricing_option_id:'seller-price',pricing_model:'cpm',currency:'EUR',fixed_price:17}]};
const doc={id:'media_buy_seller/feed_restart_probe',version:'1.0.0',title:'Restart changed wholesale feed',category:'media_buy_seller',fixtures:{products:[{product_id:'catalog-product'}]},fixture_resolution:{products:[{handle:'catalog-product',strategies:['discover'],match:[{path:'',operator:'collection_selection_satisfies',value:{collection_targeting:'selectable',minimum_pairs:2}}]}]},phases:[{id:'consume',title:'Consume',steps:[]}]};
async function run(includeLifecycle){
 const exchanges=[];let version='v1';
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
   else if(task==='get_products'){const next=msg.params.arguments.pagination?.cursor;if(next)version='v2';data={status:'completed',products:next?[offer]:[],cache_scope:'account',wholesale_feed_version:version,pagination:{has_more:!next,...(!next?{cursor:'next'}:{})}};}
   else if(task==='create_media_buy')data={status:'completed',...(includeLifecycle?{media_buy_status:'active'}:{}),media_buy_id:'seller-buy',confirmed_at:'2026-10-23T00:00:00Z',revision:1,packages:[{package_id:'seller-package',targeting_overlay:{collection_selection:{mode:'selected',collections:[{publisher_domain:'studio.example',collection_ids:['a','b']}]}}}]};
   else if(task==='get_media_buys')data={status:'completed',media_buys:[{media_buy_id:'seller-buy',status:'active',currency:'EUR',total_budget:1000,confirmed_at:'2026-10-23T00:00:00Z',revision:1,packages:[{package_id:'seller-package'}]}]};
   else throw Error('Unexpected task '+task);
   exchanges.push({task,request:msg.params.arguments,response:data});result={content:[{type:'text',text:JSON.stringify(data)}]};
  }else throw Error('Unexpected method '+msg.method);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}),{headers:{'content-type':'application/json'}});
 };
 const result=await runStoryboard('https://status-control.example/mcp',doc,{adcpVersion:'3.2.5',brand:account.brand,sandbox:true,timeout_ms:3000,profile:{tools,raw_capabilities:caps,supported_protocols:['media_buy']},transport:{trustedFetchFn}});
 console.log(JSON.stringify({disposition:result.disposition,exchanges}));
 return {disposition:result.disposition,exchanges};
}
(async()=>{
 const result=await run(true);
 const pages=result.exchanges.filter(e=>e.task==='get_products');
 assert.deepEqual(pages.map(e=>e.request.pagination?.cursor),[undefined,'next',undefined,'next'],'buyer MUST restart from cursor:null when feed version changes between pages');
})().catch(error=>{console.error(error);process.exitCode=1;});
