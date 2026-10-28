import {readFile, stat} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const hash=value=>createHash('sha256').update(value).digest('hex');
const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
export function clean(value,max=160){
  return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ')
    .replace(/Bearer\s+\S+/gi,'[已隐藏凭据]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[已隐藏凭据]')
    .replace(/\b(?:sk-|aigw_)[A-Za-z0-9_-]{16,}\b/g,'[已隐藏凭据]')
    .replace(/(?:token|cookie|authorization|api[_-]?key)\s*[:=]\s*\S+/gi,'[已隐藏凭据]').slice(0,max);
}
export function loopbackBase(value){
  const url=new URL(value);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('invalid_loopback');
  return url;
}
export function localDay(value,timeZone='Asia/Shanghai'){
  try{return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
  catch{return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
}
const timeValue=value=>date(value)?Date.parse(value):-Infinity;
const recordStatus=r=>['success','already','observed','error','failed','rejected','uncertain','busy','running','skipped'].includes(r?.status)?r.status:'unknown';
export function projectRecord(row,accounts){
  const result=object(row.result),account=accounts.find(a=>a.id===row.account_id);
  const confirmedNew=result.automaticRewardConfirmed===true&&result.trigger==='automatic'&&result.benefitOutcome==='newly_granted';
  const newReward=confirmedNew||result.benefitOutcome==='newly_granted'&&result.trigger==='manual'&&result.serverConfirmed===true&&result.operationAttempted===true;
  const status=recordStatus(row);
  const summary=newReward?'本条记录已确认新增奖励':status==='already'?'已领取回执；本条无新增奖励':['error','failed','rejected'].includes(status)?'任务未完成；请在请求诊断页核对':status==='uncertain'?'领取结果待核对；未自动重试':status==='observed'?'已完成状态观测；不等于新增奖励':status==='success'?'任务已完成；新增奖励单独核验':status==='busy'||status==='running'?'任务处理中':'账本任务记录';
  return {id:clean(row.id,48),time:date(row.time),platform:clean(row.platform,50),accountLabel:clean(account?.label??account?.id??'未匹配账户'),status,summary,trigger:['manual','automatic'].includes(result.trigger)?result.trigger:'unknown',amount:newReward?finite(result.credits):null,newReward};
}
export function projectSnapshot({config={},observations=[],records=[],schedule={},service={},warnings=[],now=new Date().toISOString()}){
  const generatedAt=date(now)??new Date().toISOString(),day=localDay(generatedAt,config.scheduler?.timezone);
  const enabled=(Array.isArray(config.accounts)?config.accounts:[]).filter(a=>a?.enabled!==false);
  const accounts=enabled.map(account=>{
    const history=observations.filter(o=>o.account_id===account.id&&finite(o.value)!==null).sort((a,b)=>timeValue(b.checked_at)-timeValue(a.checked_at))[0];
    const today=records.filter(r=>r.account_id===account.id&&r.day===day&&date(r.time)&&timeValue(r.time)<=timeValue(generatedAt)).sort((a,b)=>Number(b.id)-Number(a.id))[0];
    const result=object(today?.result),status=recordStatus(today);
    let label='今日状态未核验',checkinStatus='unknown';
    if(today&&['error','failed','rejected'].includes(status)){label='今日任务有失败记录';checkinStatus='error';}
    else if(today&&status==='uncertain'){label='今日领取结果待核对';checkinStatus='uncertain';}
    else if(today&&status==='already'&&result.serverConfirmed===true){label='今日存在已领回执';checkinStatus='already';}
    else if(today&&status==='observed'){label='今日已观测；新增未确认';checkinStatus='observed';}
    else if(today&&status==='success'){label='今日任务已完成';checkinStatus='success';}
    const automaticRewardConfirmed=!!today&&projectRecord(today,enabled).newReward&&result.automaticRewardConfirmed===true;
    if(automaticRewardConfirmed){label='今日有自动新增奖励记录';checkinStatus='new_reward';}
    const hasTasks=(account.tasks??[]).some(t=>t.enabled!==false);
    if(!hasTasks&&!today){label='未配置自动任务';checkinStatus='not_configured';}
    let accountStatus={kind:history?'historical':'unknown',label:history?'历史快照':'暂无余额快照',detail:history?'账本历史观测；本窗口未重新核验登录与额度':'初次读取未查询上游，可点击账号重新核验'};
    if(today&&['error','failed','rejected'].includes(status))accountStatus={kind:'error',label:'今日任务存在异常',detail:'账本存在失败或拒绝记录，请在请求诊断页核对；余额时效单独标记'};
    else if(today&&status==='uncertain')accountStatus={kind:'warning',label:'领取结果待确认',detail:'账本结果尚未明确，样板不会重新提交领取'};
    else if(today&&['busy','running'].includes(status))accountStatus={kind:'info',label:'任务进行中',detail:'读取到后台任务记录；本窗口未提交新任务'};
    return {id:clean(account.id,100),platform:clean(account.platform,50),label:clean(account.label??account.id),enabled:true,canClaim:hasTasks,
      balance:{value:history?history.value:null,unit:history?clean(history.unit,24):account.platform==='zcode'?'Token':account.platform==='bigmodel'?'元':'积分',stale:true,updatedAt:history?date(history.checked_at):null},
      status:accountStatus,
      checkin:{status:checkinStatus,label,amount:automaticRewardConfirmed?finite(result.credits):null,automaticRewardConfirmed:!!automaticRewardConfirmed}};
  });
  const visibleIds=new Set(enabled.map(a=>a.id));
  const visibleRecords=records.filter(r=>visibleIds.has(r.account_id)).slice(0,60).map(r=>projectRecord(r,enabled));
  const routes=(Array.isArray(config.routes)?config.routes:[]).filter(r=>r.enabled!==false).map(r=>({id:clean(r.id,100),model:clean(r.name??r.id,200),enabled:true}));
  const next=date(schedule.nextRunAt??schedule.nextRun??schedule.runAt??schedule.nextAt??schedule.scheduledAt);
  return {mode:'live',generatedAt,service:{online:service.online===true,version:clean(service.version??'未知',40),baseUrl:clean(service.baseUrl??'',120),pid:Number.isSafeInteger(service.pid)?service.pid:null},accounts,records:visibleRecords,routes,
    schedule:{enabled:config.scheduler?.enabled===true,nextRunAt:next,label:config.scheduler?.enabled===true?'调度由原后台管理':'自动调度未启用'},
    sourceMode:'history',warnings:[...new Set(['首次载入的余额为本地历史记录；刷新全部余额或单账号重新核验可查询官方。签到需独立确认，历史已领不计为本次新增。',...warnings.map(v=>clean(v,220))])].slice(0,8)};
}
export function readLedger(file,accountIds){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('PRAGMA query_only=ON');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    const observations=tables.has('balance_observations')?accountIds.flatMap(id=>db.prepare('SELECT account_id,checked_at,unit,value FROM balance_observations WHERE account_id=? ORDER BY id DESC LIMIT 1').all(id)):[];
    const records=tables.has('records')?db.prepare('SELECT id,time,day,platform,account_id,task,status,result FROM records ORDER BY id DESC LIMIT 1000').all().map(r=>{let result={};try{result=object(JSON.parse(r.result));}catch{}return {...r,result};}):[];
    let schedule={};if(tables.has('meta')){const row=db.prepare("SELECT value FROM meta WHERE key='schedule-plan'").get();try{schedule=object(JSON.parse(row?.value??'{}'));}catch{}}
    return {observations,records,schedule};
  } finally {db.close();}
}
async function boundedJson(response){
  if(!response.ok)throw new Error('gateway_http');
  const reader=response.body?.getReader();if(!reader)throw new Error('gateway_body');
  const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024)throw new Error('gateway_size');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export async function collectSnapshot(configFile,{fetchImpl=globalThis.fetch}={}){
  const configPath=resolve(configFile),before=await readFile(configPath),config=JSON.parse(before.toString('utf8').replace(/^\uFEFF/,''));
  const dataDir=resolve(dirname(configPath),config.dataDir??'./data');
  const warnings=[];let ledger={observations:[],records:[],schedule:{}};
  try{const file=join(dataDir,'gateway.sqlite');await stat(file);ledger=readLedger(file,(config.accounts??[]).filter(a=>a.enabled!==false).map(a=>a.id));}
  catch{warnings.push('账本暂不可读；不显示推测余额或领取结果。');}
  let service={online:false},schedule=ledger.schedule;
  try{
    const runtime=JSON.parse(await readFile(join(dataDir,'runtime.json'),'utf8'));
    const base=loopbackBase(runtime.baseUrl);
    const signal=AbortSignal.timeout(4500);
    const health=await boundedJson(await fetchImpl(new URL('health',base),{method:'GET',redirect:'error',signal}));
    if(health.service!=='ai-credit-gateway')throw new Error('gateway_identity');
    service={online:true,version:health.version,baseUrl:base.href,pid:runtime.pid};
    try{
      const keys=JSON.parse(await readFile(join(dataDir,'api-keys.json'),'utf8'));
      if(typeof keys.adminKey!=='string'||!keys.adminKey)throw new Error('gateway_key');
      const state=await boundedJson(await fetchImpl(new URL('admin/state',base),{method:'GET',redirect:'error',signal:AbortSignal.timeout(4500),headers:{Authorization:`Bearer ${keys.adminKey}`}}));
      schedule=object(state.schedule);
    }catch{warnings.push('后台在线，调度状态暂未读取；保留账本计划。');}
  }catch{warnings.push('后台状态暂未连接；历史数据仍可查看，原后台未被启动或重启。');}
  if(hash(before)!==hash(await readFile(configPath)))throw new Error('configuration_changed');
  return projectSnapshot({config,...ledger,schedule,service,warnings});
}
async function cli(){
  const args=process.argv.slice(2);
  if(args.includes('--demo')){
    const data=JSON.parse(await readFile(new URL('../ui/demo.json',import.meta.url),'utf8'));
    data.mode='demo';process.stdout.write(JSON.stringify(data));return;
  }
  const at=args.indexOf('--config');if(at<0||!args[at+1])throw new Error('configuration_required');
  process.stdout.write(JSON.stringify(await collectSnapshot(args[at+1])));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  cli().catch(error=>{const code=['configuration_changed','configuration_required'].includes(error?.message)?error.message:'snapshot_read_failed';process.stderr.write(code+'\n');process.exitCode=1;});
}
