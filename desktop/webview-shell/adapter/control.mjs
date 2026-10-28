import {readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {collectSnapshot,clean,loopbackBase} from './snapshot.mjs';

const ACTIONS=new Set(['balances.refresh','account.refresh','account.claim','claims.all']);
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const obj=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const digest=value=>createHash('sha256').update(value).digest('hex');
export class ControlError extends Error{constructor(code){super(code);this.code=code;}}
export function validateRequest(request,config){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['action','accountId'].includes(k))||!ACTIONS.has(request.action))throw new ControlError('invalid_action');
  const perAccount=request.action.startsWith('account.');
  if(!perAccount&&request.accountId!==undefined)throw new ControlError('invalid_account');
  if(perAccount){
    if(typeof request.accountId!=='string'||request.accountId.length>120||!request.accountId)throw new ControlError('invalid_account');
    const account=(config.accounts??[]).find(a=>a.id===request.accountId&&a.enabled!==false);
    if(!account)throw new ControlError('account_not_enabled');
    if(request.action==='account.claim'&&!(account.tasks??[]).some(t=>t.enabled!==false))throw new ControlError('no_claim_task');
    return {action:request.action,accountId:account.id,account};
  }
  return {action:request.action};
}
async function jsonResponse(response){
  const reader=response.body?.getReader();if(!reader)throw new ControlError('invalid_response');
  const chunks=[];let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>4*1024*1024)throw new ControlError('response_too_large');chunks.push(r.value);}}
  finally{await reader.cancel().catch(()=>{});}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ControlError('invalid_response');}
  if(!response.ok)throw new ControlError('upstream_operation_failed');
  return obj(value);
}
export function overlayBalances(snapshot,rows){
  const byId=new Map((Array.isArray(rows)?rows:[]).map(r=>[r.accountId,r]));
  let verified=0;
  const accounts=snapshot.accounts.map(a=>{
    const row=byId.get(a.id);if(!row)return a;
    if(row.error||row.stale===true)return {...a,status:{kind:'error',label:'余额核验未完成',detail:'保留可识别的历史记录，请在任务或诊断中核对；未伪报实时成功'},balance:{...a.balance,stale:true}};
    verified++;
    const daily=obj(row.dailyCheckin);let checkin=a.checkin;
    if(daily.known===true||typeof daily.todayCheckedIn==='boolean'){
      const yes=daily.todayCheckedIn===true||daily.status==='claimed';
      checkin={status:yes?'already':daily.status==='observed'?'observed':daily.status==='not_available'?'not_available':daily.status==='claimable'?'claimable':'unknown',label:yes?'官方确认今日已领取':daily.status==='not_available'?'当前无每日领取资格':daily.status==='observed'?'官方状态已观测；新增另行核对':daily.status==='claimable'?'当前可领取':'每日权益尚未核验',amount:number(daily.credits),automaticRewardConfirmed:a.checkin?.automaticRewardConfirmed===true};
    }
    return {...a,balance:{value:number(row.value),unit:clean(row.unit??a.balance.unit,24),stale:false,updatedAt:typeof row.checkedAt==='string'&&Number.isFinite(Date.parse(row.checkedAt))?new Date(row.checkedAt).toISOString():new Date().toISOString()},
      status:{kind:'ok',label:number(row.value)!==null?'官方余额已核验':'平台连接已核验',detail:clean(row.note??'本次显式操作取得的官方响应；领取结果单独查看',180)},checkin};
  });
  return {...snapshot,accounts,sourceMode:verified===accounts.length?'live_verified':'mixed',warnings:[...(snapshot.warnings??[]).filter(s=>!s.startsWith('余额来自只读账本历史快照')&&!s.startsWith('首次载入的余额为本地历史记录')),'本次已核验项显示官方响应；其余保留历史标记。余额、已领回执和本次新增分别核对。']};
}
async function defaultNormalize(account,health,configFile){
  const root=dirname(configFile);
  const candidates=[join(root,'src','balances.mjs'),join(root,'core','src','balances.mjs')];
  let module;
  for(const file of candidates){try{await readFile(file);module=await import(pathToFileURL(file));break;}catch(error){if(error?.code!=='ENOENT')throw new ControlError('normalizer_unavailable');}}
  if(!module)throw new ControlError('normalizer_unavailable');
  if(account.platform==='workbuddy')return module.workBuddyBalanceSnapshot(account,health);
  return {accountId:account.id,platform:account.platform,...module.normalizeBalance(account.platform,health),checkedAt:new Date().toISOString(),stale:false,...(health.checkin?{dailyCheckin:{...health.checkin,todayCheckedIn:health.checkin.claimed??health.checkin.checkedIn??null}}:{})};
}
const friendly={invalid_action:'操作类型无效，请重新打开当前页面。',invalid_account:'账号参数无效，请刷新目录后重试。',account_not_enabled:'账号已停用或配置已变，请刷新目录。',no_claim_task:'当前账号没有启用的签到任务，请在账号管理中设置。',configuration_changed:'配置已发生变化，本次操作未继续，请重新读取。',gateway_identity:'当前端口不是网关服务，请检查后台连接。',normalizer_unavailable:'平台响应已取得，展示适配暂未完成，请查看诊断。',upstream_operation_failed:'后台未完成此操作，请查看任务记录与诊断。'};
export async function performAction(configFile,request,{fetchImpl=globalThis.fetch,snapshotReader=collectSnapshot,normalizeHealth=defaultNormalize}={}){
  const file=resolve(configFile),before=await readFile(file),config=JSON.parse(before.toString('utf8').replace(/^\uFEFF/,'')),action=validateRequest(request,config);
  const data=resolve(dirname(file),config.dataDir??'./data');
  const runtime=JSON.parse(await readFile(join(data,'runtime.json'),'utf8')),base=loopbackBase(runtime.baseUrl);
  const keys=JSON.parse(await readFile(join(data,'api-keys.json'),'utf8'));
  if(typeof keys.adminKey!=='string'||!keys.adminKey)throw new ControlError('gateway_credentials');
  const health=await jsonResponse(await fetchImpl(new URL('health',base),{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000)}));
  if(health.service!=='ai-credit-gateway')throw new ControlError('gateway_identity');
  if(digest(before)!==digest(await readFile(file)))throw new ControlError('configuration_changed');
  const claim=action.action==='account.claim'||action.action==='claims.all';
  const endpoint=action.action==='balances.refresh'?'admin/balances?refresh=1':action.action==='account.refresh'?'admin/health':'admin/claim';
  const body=action.action==='account.refresh'?{accountId:action.accountId}:action.action==='account.claim'?{accountId:action.accountId,taskId:(action.account.tasks??[]).find(t=>t.enabled!==false)?.id??'daily-checkin'}:{};
  const options={method:action.action==='balances.refresh'?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(claim?155000:45000),headers:{Authorization:`Bearer ${keys.adminKey}`,...(action.action==='balances.refresh'?{}:{'Content-Type':'application/json'})},...(action.action==='balances.refresh'?{}:{body:JSON.stringify(body)})};
  let result;
  try{result=await jsonResponse(await fetchImpl(new URL(endpoint,base),options));}
  catch(error){
    const snapshot=await snapshotReader(file).catch(()=>undefined);
    return {snapshot,operation:{kind:action.action,status:claim?'uncertain':'failed',accountId:action.accountId,message:claim?'提交后的结果尚未确认；本窗口不会自动重试，请先查看领取记录。':'余额核验未完成，已有数据保留；请查看诊断后重新核验。'}};
  }
  let snapshot=await snapshotReader(file);
  if(digest(before)!==digest(await readFile(file))){
    return {snapshot,operation:{kind:action.action,status:claim?'uncertain':'failed',accountId:action.accountId,message:claim?'操作期间配置发生变化；先核对领取记录，本窗口不会自动重试。':'操作期间账号配置发生变化，旧响应未覆盖新账号，请重新核验。'}};
  }
  if(!claim){
    let rows;
    if(action.action==='balances.refresh')rows=Array.isArray(result.accounts)?result.accounts:[];
    else{try{rows=[await normalizeHealth(action.account,result,file)];}catch{rows=[{accountId:action.accountId,error:true}];}}
    snapshot=overlayBalances(snapshot,rows);
    if(!rows.length)return {snapshot,operation:{kind:action.action,status:'failed',message:'后台未返回可核对的余额条目，请查看诊断。'}};
    const failed=rows.filter(r=>r.error||r.stale===true).length;
    return {snapshot,operation:{kind:action.action,status:failed?'partial':'completed',accountId:action.accountId,message:failed?'核验已结束，部分账号返回异常；历史数据已保留。':'官方核验已完成，余额与每日权益已分别更新。'}};
  }
  const results=Array.isArray(result.results)?result.results:[result];
  const uncertain=results.filter(r=>['uncertain','busy','running'].includes(r.status)).length;
  const errors=results.filter(r=>['error','failed','rejected'].includes(r.status)).length;
  return {snapshot,operation:{kind:action.action,status:uncertain?'uncertain':errors?'partial':'completed',accountId:action.accountId,message:`执行结束：${results.length} 项回执，${errors} 项异常，${uncertain} 项待确认；新增奖励请逐条核对领取记录。`}};
}
async function cli(){
  const args=process.argv.slice(2),config=args[args.indexOf('--config')+1],input=args[args.indexOf('--request')+1];
  if(args.indexOf('--config')<0||args.indexOf('--request')<0||!config||!input||input.length>16384)throw new ControlError('invalid_action');
  const request=JSON.parse(input);
  try{process.stdout.write(JSON.stringify(await performAction(config,request)));}
  catch(error){process.stdout.write(JSON.stringify({operation:{kind:ACTIONS.has(request?.action)?request.action:'unknown',status:'failed',message:friendly[error?.code]??'操作尚未完成，请检查当前连接与任务记录。'}}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){cli().catch(()=>{process.stderr.write('control_request_failed\n');process.exitCode=1;});}
