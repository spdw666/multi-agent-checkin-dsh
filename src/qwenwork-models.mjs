// COSY request preparation adapted from wicm84266964/Buddy2api (MIT).
// Encoding uses the WASM shipped by the user's QwenWork installation.
import {createCipheriv,publicEncrypt,constants,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {projectRoot} from './config.mjs';
import {AppError} from './util.mjs';
const origin='https://gateway.qwenwork.cn';
const pem=`-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
export function qwenCosy(c,url,body='') {
 const k=Buffer.from(randomUUID().replaceAll('-','').slice(0,16));const aes=createCipheriv('aes-128-cbc',k,k);
 const info=Buffer.concat([aes.update(JSON.stringify({uid:c.principal,aid:'',name:c.user?.name??'',email:c.user?.email??'',security_oauth_token:c.accessToken})),aes.final()]).toString('base64');
 const key=publicEncrypt({key:pem,padding:constants.RSA_PKCS1_PADDING},k).toString('base64');k.fill(0);
 const date=String(Math.floor(Date.now()/1000)),head=Buffer.from(JSON.stringify({version:'v1',requestId:randomUUID().replaceAll('-',''),info,cosyVersion:'1.1.32',ideVersion:'1.2.5'})).toString('base64');
 const path=new URL(url).pathname.replace(/^\/algo/,'');const digest=createHash('md5').update([head,key,date,body,path].join('\n')).digest('hex');
 return {Authorization:`Bearer COSY.${head}.${digest}`,'Cosy-Key':key,'Cosy-User':c.principal,'Cosy-Date':date};
}
export function qwenModelHeaders(model='qwork-advanced') {return {'Content-Type':'application/json','User-Agent':'qoderwork/1.2.5','X-QwenWork-Version':'1.2.5','X-QwenWork-Release-Version':'1.2.5-26092902','X-QwenWork-Build':'26092902','X-QwenWork-Platform':process.platform,'X-QwenWork-Arch':process.arch,'X-QwenWork-Channel':'stable','Cosy-Version':'1.1.32','Cosy-ClientType':'6','Cosy-Business-Product':'qoder_work','Cosy-Business-Type':'agent','Cosy-Scene':'qwork','Cosy-MachineOS':'x86_64_win32','Cosy-MachineType':'5','Cosy-Data-Policy':'disagree','Login-Version':'v2','X-Model-Key':model,'X-Model-Source':'system','x-internal-model-key':model};}
export async function qwenWorkModels(c){
 const url=origin+'/api/v2/model/list';const r=await fetch(url,{headers:{...qwenModelHeaders(),...qwenCosy(c,url)},signal:AbortSignal.timeout(30000)});
 const raw=await r.json();if(!r.ok)throw new AppError('QwenWork catalog HTTP '+r.status,r.status,'qwenwork_catalog_error');
 const data=raw.data??raw;let rows=Array.isArray(data)?data:data.qwork??data.models??data.model_list??data.list??[];if(!Array.isArray(rows))rows=rows.models??rows.list??rows.model_list??[];
 return rows.filter(m=>m.enable!==false&&m.isEnabled!==false).map(m=>({id:m.key??m.value??m.id??m.modelId,name:m.display_name??m.displayName??m.key??m.id,tools:m.supportsToolCall===true||['flash','pro','qwen3.8-max-preview'].includes(m.key??m.id),multimodal:m.is_vl===true||m.supportsImages===true,contextWindow:m.max_input_tokens??32768,maxTokens:m.max_output_tokens??4096,source:'live-qwenwork-catalog',transportVerified:['flash','pro','qwen3.8-max-preview'].includes(m.key??m.id)})).filter(m=>m.id);
}
export function qwenBody(request){const id=randomUUID(),last=[...request.messages].reverse().find(m=>m.role==='user')?.content??'';const system=request.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 return {request_id:id,request_set_id:id,chat_record_id:id,session_id:randomUUID(),stream:true,chat_task:'FREE_INPUT',chat_context:{text:typeof last==='string'?last:'',features:[],extra:{context:[],modelConfig:{key:request.model,is_reasoning:false},originalContent:last},chatPrompt:'',imageUrls:null},is_reply:true,is_retry:false,source:1,version:'3',agent_id:'agent_common',task_id:'common',session_type:'qoder_work',aliyun_user_type:'',model_config:{key:request.model,display_name:request.model,model:'',format:'openai',is_vl:request.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')),is_reasoning:false,api_key:'',url:'',source:'system',max_input_tokens:1000000},system,messages:request.messages,tools:request.tools??[],...(request.tool_choice!==undefined?{tool_choice:request.tool_choice}:{}),parameters:{max_tokens:request.max_completion_tokens??request.max_tokens??4096,...(request.temperature!==undefined?{temperature:request.temperature}:{})},business:{product:'qoder_work',type:'agent',version:'1',feature_switches:{}}};
}
export function packQwen(c,body,signal){return new Promise((resolve,reject)=>{
 const py=process.env.QWENWORK_PYTHON??join(projectRoot,'vendor/qwen-python',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const env={...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};delete env.PYTHONHOME;delete env.PYTHONPATH;
 const p=spawn(py,[join(projectRoot,'vendor/qwen-pack.py')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',done=false;
 const end=(err,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);};const abort=()=>{p.kill();end(new AppError('QwenWork request cancelled',499,'request_cancelled'));};const timer=setTimeout(()=>{p.kill();end(new AppError('QwenWork encoder timeout',504,'qwenwork_encoder_timeout'));},15000);
 p.on('error',()=>end(new AppError('QwenWork encoder runtime missing',424,'qwenwork_encoder_missing')));p.stderr.on('data',()=>{});p.stdout.on('data',b=>{out+=b;if(out.length>16*1024*1024)abort();});p.on('close',code=>{try{const value=JSON.parse(out);if(code!==0||value.error){const kind=/^[A-Za-z]{1,50}$/.test(value.error??'')?value.error:'runtime';end(new AppError('QwenWork encoder failed ('+kind+')',422,'qwenwork_encoder_error'));return;}end(null,value);}catch{end(new AppError('QwenWork encoder output invalid',422,'qwenwork_encoder_error'));}});
 signal?.addEventListener('abort',abort,{once:true});p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify({body:JSON.stringify(body),model_key:body.model_config.key,machine_id:c.identity?.deviceId??'',uid:c.principal,name:c.user?.name??'',email:c.user?.email??'',access_token:c.accessToken}));
});}
export async function qwenWorkChat(c,request,signal){
 const packed=await packQwen(c,qwenBody(request),signal);const r=await fetch(packed.url,{method:'POST',headers:{...qwenModelHeaders(request.model),...packed.headers,Accept:'text/event-stream'},body:packed.body,signal});
 if(!r.ok){await r.body?.cancel();throw new AppError('QwenWork model HTTP '+r.status,r.status,'qwenwork_model_error');}
 const decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='';
 const stream=new ReadableStream({async start(controller){try{for await(const chunk of r.body){buffer+=decoder.decode(chunk,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line.startsWith('data:'))continue;const text=line.slice(5).trim();if(!text||text==='[DONE]')continue;const outer=JSON.parse(text);if(outer.statusCodeValue>=400)throw new AppError('QwenWork envelope HTTP '+outer.statusCodeValue,outer.statusCodeValue,'qwenwork_envelope_error');if(outer.body==='[DONE]'||outer.body==='{}'||outer.body==='null')continue;const inner=outer.choices?outer:typeof outer.body==='string'?JSON.parse(outer.body):outer.body;if(inner?.choices)controller.enqueue(encoder.encode('data: '+JSON.stringify(inner)+'\n\n'));}}controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();}catch(e){controller.error(e);}}});
 return {response:new Response(stream,{headers:{'Content-Type':'text/event-stream'}})};
}
