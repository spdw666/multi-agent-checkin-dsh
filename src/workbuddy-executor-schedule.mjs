import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AppError,hash,rememberSecret,atomicJson} from './util.mjs';
import {findWorkBuddyExecutorCli,findWorkBuddyExecutorNode,workBuddyExecutorEnvironment} from './workbuddy-executor-cli.mjs';

// Official CLI 5.8.2 Generic bridge createSessionForConversation (3817465)
// creates a session but never setCurrent/start cron. ACP session/new goes through
// initializeSession -> /internal/agent (2572755). setCurrent starts cron
// (7380734), which initializes CronStateManager.storageDir (2118657).
// Initialization is not a model prompt and never spends generation for warmup.
const wait=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted){reject(signal.reason);return;}const timer=setTimeout(done,ms);function abort(){clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason);}function done(){signal?.removeEventListener('abort',abort);resolve();}signal?.addEventListener('abort',abort,{once:true});});
const getPort=()=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,256}$/.test(value)?value:null;
const closeChild=child=>new Promise(resolve=>{if(child.exitCode!==null){resolve();return;}let timer;const done=()=>{clearTimeout(timer);child.removeListener('close',done);resolve();};child.once('close',done);timer=setTimeout(done,2000);child.kill();});
const result=(status,reason,evidence={})=>({status,reason,feature:'automation',completedActions:status==='completed'?1:0,evidence});
const unwrap=data=>data?.data??data;
function rpcResult(row,requestId){
  if(Array.isArray(row))return row.map(item=>rpcResult(item,requestId)).find(item=>item!==undefined);
  if(!row||row.id!==requestId)return;
  if(row.error)throw new AppError('官方 ACP 会话初始化未确认',502,'wb_schedule_acp_rejected');
  if(!row.result||typeof row.result!=='object')throw new AppError('官方 ACP 会话响应待确认',502,'wb_schedule_acp_invalid');
  return row.result;
}
async function readRpc(response,requestId){
  if(response.headers.get('content-type')?.includes('application/json')){const value=rpcResult(await response.json(),requestId);if(value!==undefined)return value;throw new AppError('官方 ACP 响应缺少请求结果',502,'wb_schedule_acp_invalid');}
  const reader=response.body?.getReader();if(!reader)throw new AppError('官方 ACP 会话流待确认',502,'wb_schedule_acp_invalid');
  const decoder=new TextDecoder();let text='',bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1024*1024)throw new AppError('官方 ACP 初始化流超出上限',502,'wb_schedule_acp_limit');text+=decoder.decode(part.value,{stream:true});let match;while((match=/\r?\n\r?\n/.exec(text))){const frame=text.slice(0,match.index);text=text.slice(match.index+match[0].length);const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;let row;try{row=JSON.parse(data);}catch{continue;}const value=rpcResult(row,requestId);if(value!==undefined)return value;}}
    throw new AppError('官方 ACP 初始化流尚未确认',502,'wb_schedule_acp_unconfirmed');
  }finally{await reader.cancel().catch(()=>{});}
}
function futureCron(){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',minute:'2-digit',hour:'2-digit',hourCycle:'h23',day:'2-digit',month:'2-digit'}).formatToParts(new Date(Date.now()+86400000)).map(p=>[p.type,p.value]));return `${Number(parts.minute)} ${Number(parts.hour)} ${Number(parts.day)} ${Number(parts.month)} *`;}
export async function executeWorkBuddyCliSchedule({service,accountId,operationId,signal,check=()=>{},markSubmitted,action={}}){
  check();signal?.throwIfAborted();if(typeof operationId!=='string'||!operationId)return result('unsupported','schedule_operation_identity_required');
  const c=await service.credentials.resolve(accountId);check();signal?.throwIfAborted();const runtime=service.workbuddyRuntime??{},cli=runtime.executorCli??await findWorkBuddyExecutorCli();if(!cli)return result('deferred','wb_executor_cli_missing');
  const root=join(service.config.dataDir,'wb-executor-runtime',hash(accountId+'\0'+String(c.uid??c.principal))),cwd=join(root,'workspace'),env=workBuddyExecutorEnvironment(c,root,cli.productFile),marker='AI积分网关-'+hash(operationId).slice(0,24),needle='['+marker+']',project=join(cwd,'.codebuddy'),file=join(project,'scheduled_tasks.json'),contextFile=join(root,'schedules',hash(operationId)+'.json');
  env.CODEBUDDY_PROJECT_CONFIG_DIR=project;env.TZ='Asia/Shanghai';
  for(const name of ['home','appdata','localappdata','tmp','config','data','workspace'])await mkdir(join(root,name),{recursive:true,mode:0o700});
  let sessionId=validId(action.sessionId);for(const path of [contextFile,join(root,'last-execution.json')])if(!sessionId)try{sessionId=validId(JSON.parse(await readFile(path,'utf8')).sessionId);}catch{}
  const port=await(runtime.scheduleGetPort??getPort)();if(!Number.isInteger(port)||port<1||port>65535)throw new AppError('官方执行组件端口格式错误',500,'wb_schedule_port_invalid');
  const node=runtime.executorNode??await findWorkBuddyExecutorNode(),child=(runtime.spawnScheduleCli??spawn)(node,[cli.file,'--serve','--host','127.0.0.1','--port',String(port),'--auth','password','--setting-sources','user'],{env,cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',password=null,spawnError=null,connectionId=null,sessionToken=null,resourceId=validId(String(action.resourceId??'')),submitted=false;
  child.once('error',e=>{spawnError=e;});child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');const collect=text=>{if(output.length<65536)output+=text;};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const abort=()=>{child.kill();};signal?.addEventListener('abort',abort,{once:true});
  const request=async(path,{method='GET',body,rpcId}={})=>{
    check();signal?.throwIfAborted();const response=await(runtime.localFetchImpl??fetch)('http://127.0.0.1:'+port+path,{method,headers:{Authorization:'Bearer '+password,'X-CodeBuddy-Request':'1','Content-Type':'application/json',Accept:rpcId?'application/json, text/event-stream':'application/json',...(connectionId?{'acp-connection-id':connectionId}:{}),...(sessionToken?{'acp-session-token':sessionToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    check();signal?.throwIfAborted();if(!response.ok){await response.body?.cancel().catch(()=>{});throw new AppError('官方定时执行组件请求待确认',response.status,'wb_schedule_request_unconfirmed');}
    if(rpcId)return readRpc(response,rpcId);let data;try{data=await response.json();}catch{throw new AppError('官方定时执行组件响应格式错误',502,'wb_schedule_response_invalid');}if(data?.error||data?.success===false)throw new AppError('官方定时执行组件响应未确认',502,'wb_schedule_response_invalid');return unwrap(data);
  };
  const rpc=(id,method,params)=>request('/api/v1/acp',{method:'POST',body:{jsonrpc:'2.0',id,method,params},rpcId:id});
  const list=async()=>{const data=await request('/api/v1/scheduled-tasks?sessionId='+encodeURIComponent(sessionId));const rows=Array.isArray(data)?data:data?.tasks;if(!Array.isArray(rows))throw new AppError('官方自动化列表结构待确认',502,'wb_schedule_list_invalid');return rows;};
  const find=rows=>rows.find(t=>validId(String(t.id??''))&&String(t.prompt??'').includes(needle)&&(!resourceId||String(t.id)===resourceId));
  const diskRow=async()=>{try{const value=JSON.parse(await readFile(file,'utf8'));return Array.isArray(value.tasks)?find(value.tasks):null;}catch{return null;}};
  try{
    let ready=false;for(let i=0;i<150;i++){check();signal?.throwIfAborted();if(spawnError||child.exitCode!==null)throw new AppError('官方定时执行组件启动失败',503,'wb_schedule_start_failed');const clean=output.replace(/\x1b\[[0-9;]*m/g,'');password=clean.match(/[?&]password=([^\s\x1b"'<>]+)/)?.[1]??clean.match(/\bPassword\s+([^\s\x1b]+)/)?.[1];if(password){try{password=decodeURIComponent(password);}catch{}rememberSecret(password);try{await request('/api/v1/health');ready=true;break;}catch(e){check();signal?.throwIfAborted();}}await wait(runtime.scheduleStartupDelay??200,signal);}if(!ready)throw new AppError('官方定时执行组件认证未就绪',503,'wb_schedule_auth_not_ready');
    const connected=await request('/api/v1/acp/connect',{method:'POST'});connectionId=validId(connected.connectionId);if(!connectionId)throw new AppError('官方 ACP 连接尚未确认',502,'wb_schedule_acp_connection_invalid');sessionToken=typeof connected.sessionToken==='string'?connected.sessionToken:null;if(sessionToken)rememberSecret(sessionToken);
    await rpc('gateway-initialize','initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'ai-credit-gateway-scheduler',version:'1'}});
    const initialized=await rpc('gateway-session',sessionId?'session/load':'session/new',{...(sessionId?{sessionId}:{}),cwd,mcpServers:[]});sessionId=validId(initialized.sessionId)??sessionId;if(!sessionId)throw new AppError('官方自动化会话尚未确认',502,'wb_schedule_session_unconfirmed');
    await atomicJson(contextFile,{sessionId,operationHash:hash(operationId),checkedAt:new Date().toISOString()});
    let found=find(await list());
    if(!found){
      if(action.submitted&&action.phase!=='seed')return result('pending','previous_schedule_submission_not_found',resourceId?{resourceId}:{});
      if(typeof markSubmitted!=='function')return result('deferred','schedule_submission_persistence_required');
      check();await markSubmitted({phase:'schedule'});check();signal?.throwIfAborted();submitted=true;
      try{await request('/api/v1/scheduled-tasks',{method:'POST',body:{cron:futureCron(),prompt:needle+' 整理此专用工作目录，生成文件清单与归档建议。不要访问目录外文件，不发送外部消息。',recurring:false,durable:true,sessionId}});}catch(e){check();signal?.throwIfAborted();}
      found=find(await list());
    }
    if(!found)return result('pending','schedule_creation_readback_unconfirmed');resourceId=String(found.id);
    if(!(await diskRow()))return result('pending','schedule_durable_file_unconfirmed',{resourceId,resourceVerified:false});
    if(found.enabled!==false){if(typeof markSubmitted!=='function')return result('pending','schedule_pause_persistence_required',{resourceId});check();await markSubmitted({phase:'pause',resourceId});check();signal?.throwIfAborted();await request('/api/v1/scheduled-tasks/'+encodeURIComponent(resourceId),{method:'PATCH',body:{enabled:false,sessionId}});}
    const readback=find(await list()),disk=await diskRow();if(!readback||readback.enabled!==false||!disk||disk.enabled!==false||disk.cron!==readback.cron)return result('pending','schedule_pause_readback_unconfirmed',{resourceId,resourceVerified:false});
    return result('completed','official_cli_schedule_created_and_read_back',{resourceId,resourceVerified:true,paused:true,durable:true,sessionInitializedWithoutGeneration:true});
  }catch(error){check();signal?.throwIfAborted();if(error?.name==='AbortError')throw error;return result(submitted||action.submitted||resourceId?'pending':'deferred',error.code??'schedule_official_entry_unconfirmed',resourceId?{resourceId,resourceVerified:false}:{});}
  finally{signal?.removeEventListener('abort',abort);await closeChild(child);}
}
