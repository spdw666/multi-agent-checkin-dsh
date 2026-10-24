import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {loadConfig} from './runtime/src/config/loader.ts';
import {AuthManager} from './runtime/src/auth/manager.ts';
import {proxyRequest} from './runtime/src/proxy/handler.ts';
const root=path.dirname(fileURLToPath(import.meta.url));
// Match the observed native direct-transport policy; do not inherit this shell's proxy.
for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete process.env[key];
for(const key of ['ZCODE_CLAIM_ENABLED','ZCODE_CLAIM_AUTO','ZCODE_ASYNC_ENABLED','ZCODE_HIGHSPEED_ENABLED','ZCODE_MCP_GATEWAY'])process.env[key]='false';
process.env.ZCODE_UPDATE_CHECK='off';process.env.ZCODE_PANEL_ENABLED='false';delete process.env.ZCODE_DUMP_UPSTREAM;
const privateFile=path.join(root,'bridge-private.json'),secret=JSON.parse(fs.readFileSync(privateFile,'utf8'));
if(secret.enabled!==true)throw Error('BRIDGE_DISABLED');
const config=loadConfig(path.join(root,'config.json'));
if(config.plan!=='start-plan'||config.provider!=='zai'||config.claim.enabled||config.claim.auto||config.async.enabled||config.highspeed.enabled||config.mcp.gateway.enabled)throw Error('ISOLATION_CONFIG_INVALID');
const traceFile=path.join(root,'bridge-trace.jsonl');
const key=Buffer.from(secret.localKey);const authorize=(req:Request)=>{const b=Buffer.from((req.headers.get('authorization')??'').replace(/^Bearer /,''));return b.length===key.length&&timingSafeEqual(b,key);};
function codeOf(x:any){const n=Number(x?.code??x?.error?.code);return Number.isSafeInteger(n)&&n!==0&&n!==200?n:undefined;}
function inspect(meta:any,text:string){try{const v=JSON.parse(text),code=codeOf(v);if(code!==undefined){meta.businessCode=code;meta.errorType=String(v.error?.type??'upstream_business_error');}}catch{}}
function tapResponse(response:Response,meta:any):Response{
 if(!response.body)return response;
 const decoder=new TextDecoder();let buffer='';
 const tapped=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){buffer+=decoder.decode(chunk,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';for(const line of lines)if(line.startsWith('data:'))inspect(meta,line.slice(5).trim());if(buffer.length>4*1024*1024)buffer='';controller.enqueue(chunk);},flush(){buffer+=decoder.decode();if(buffer.startsWith('data:'))inspect(meta,buffer.slice(5).trim());}}));
 return new Response(tapped,{status:response.status,statusText:response.statusText,headers:response.headers});
}
const server=Bun.serve({hostname:'127.0.0.1',port:secret.port,idleTimeout:0,maxRequestBodySize:16*1024*1024,async fetch(req){
 const url=new URL(req.url);if(!authorize(req))return Response.json({error:{code:'bridge_auth_required'}},{status:401});
 if(url.pathname==='/health')return Response.json({ready:true,implementation:'TriDefender/zcode-api',commit:'9880d91579fdb9d3e59c2bb900add3ab86722003',plan:'start-plan',nativeAppVersion:secret.nativeAppVersion,backgroundFeatures:false});
 if(req.method!=='POST'||url.pathname!=='/v1/chat/completions')return new Response('Not found',{status:404});
 const jwt=req.headers.get('x-gateway-upstream-token'),device=req.headers.get('x-gateway-device-id');if(!jwt||!device)return Response.json({error:{code:'bridge_upstream_auth_missing'}},{status:401});
 const controller=new AbortController();req.signal.addEventListener('abort',()=>controller.abort(req.signal.reason),{once:true});
 const meta:any={id:randomUUID(),at:new Date().toISOString(),implementationCommit:'9880d91579fdb9d3e59c2bb900add3ab86722003',model:'',inputTools:0,dispatchAttempts:0,officialStatuses:[],nativeAgentDelegation:false};let completed=false;
 const finish=(status:string)=>{if(completed)return;completed=true;meta.end=new Date().toISOString();meta.result=status;fs.appendFileSync(traceFile,JSON.stringify(meta)+'\n');console.log('BRIDGE_RESULT '+JSON.stringify(meta));};
 try{
  const raw=await req.text(),input=JSON.parse(raw);meta.model=input.model;meta.inputTools=input.tools?.length??0;meta.inputMessages=input.messages?.length??0;meta.inputBytes=Buffer.byteLength(raw);
  if(typeof input.model!=='string'||!input.model.trim())return Response.json({error:{code:'bridge_model_missing'}},{status:400});
  const auth=new AuthManager();auth.setOAuthCredential({provider:'zai',apiKey:jwt,jwt});
  const requestConfig={...config,identity:{...config.identity,appVersion:secret.nativeAppVersion,deviceMid:device}};
  const clean=new Request('http://127.0.0.1:'+secret.port+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:raw,signal:controller.signal});
  const result=await proxyRequest(clean,'openai',{
   config:requestConfig,auth,debug:false,
   onUpstreamResponse:async(response:Response,body:string|undefined)=>{
    meta.dispatchAttempts++;meta.upstreamStatus=response.status;meta.officialStatuses.push(response.status);
    if(body){const b=JSON.parse(body);meta.wireTools=b.tools?.length??0;meta.wireBudget=b.max_tokens;meta.wireThinkingBudget=b.thinking?.budget_tokens;meta.wireEffort=b.output_config?.effort;meta.toolSchemasSha256=createHash('sha256').update(JSON.stringify(b.tools?.map((t:any)=>({name:t.name,schema:t.input_schema}))??[])).digest('hex');}
    if(!response.ok){const text=await response.clone().text();inspect(meta,text);return response;}
    return (response.headers.get('content-type')??'').includes('text/event-stream')?tapResponse(response,meta):response;
   }
  });
  const headers=new Headers(result.headers);headers.delete('content-length');headers.delete('content-encoding');headers.set('x-gateway-bridge-id',meta.id);if(meta.upstreamStatus)headers.set('x-gateway-upstream-status',String(meta.upstreamStatus));if(meta.businessCode)headers.set('x-gateway-upstream-code',String(meta.businessCode));
  if(!result.body){finish('empty');return new Response(null,{status:result.status,headers});}
  const reader=result.body.getReader();const encoder=new TextEncoder();
  const stream=new ReadableStream<Uint8Array>({async pull(c){try{const item=await reader.read();if(meta.businessCode===3012){c.enqueue(encoder.encode('data: '+JSON.stringify({error:{code:'zcode_upstream_blocked',upstreamCode:3012,upstreamStatus:meta.upstreamStatus,message:'ZCode upstream rejected the current request'}})+'\n\n'));controller.abort();await reader.cancel().catch(()=>{});finish('upstream_business_3012');c.close();return;}if(item.done){finish(result.ok?'completed':'http_error');c.close();return;}c.enqueue(item.value);}catch(error){finish(controller.signal.aborted?'aborted':'stream_error');c.error(error);}},async cancel(reason){controller.abort(reason);await reader.cancel(reason).catch(()=>{});finish('client_cancelled');}});
  return new Response(stream,{status:result.status,headers});
 }catch(error){controller.abort();meta.localError=(error as Error).name;finish('bridge_error');return Response.json({error:{code:'zcode_bridge_error',message:'Local ZCode proxy processing failed'}},{status:502});}
}});
console.log('ZCODE_FULL_PROXY_READY host=127.0.0.1 port='+server.port+' plan=start-plan models=declared-request claim=false idle=false highspeed=false mcp=false');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.stop(true);process.exit(0);});
