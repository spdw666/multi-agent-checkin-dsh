// Independently implemented after reviewing WorkBuddy2API Panel (MIT).
import {AppError,atomicJson,hash} from './util.mjs';
import {CredentialManager} from './credentials.mjs';
import {join} from 'node:path';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {syncWorkBuddyPools} from './workbuddy-management.mjs';
import {workBuddyEdition} from './workbuddy-auth.mjs';
import {isWorkBuddyBlocked} from './workbuddy-status.mjs';

export function isCreditExhausted(error) {
  const status=Number(error.status);
  if(/context_length|context_window|prompt_too_long|input_token_limit/i.test(String(error.code??''))||/context (?:window|length)|prompt (?:is )?too long|maximum context|input tokens? .*limit/i.test(String(error.message??'')))return false;
  // Rate limiting, authentication and bad model parameters are not empty wallets.
  if([401,429].includes(status))return false;
  if(status===402)return true;
  return /insufficient credits?|credits? exhausted|out of credits?|not enough credits?|quota (?:exceeded|exhaust)|payment required|积分不足|额度不足|余额不足|积分用完|额度用尽|没有积分/i.test(String(error.message??''));
}
export class WorkBuddyPool {
  constructor(config,ledger){Object.assign(this,{config,ledger});this.memory=new Map();}
  get(key){return this.ledger?.get(key)??this.memory.get(key);}
  set(key,value){if(this.ledger)this.ledger.set(key,value);else this.memory.set(key,value);}
  candidates(route,{ignoreCooldown=false,includeBlocked=false}={}) {
    if(!route.accountPool?.enabled)return route.targets.filter(t=>{const u=(this.config.value.upstreams??[]).find(u=>u.id===t.upstreamId);if(u?.kind!=='workbuddy')return true;const a=this.config.value.accounts?.find(a=>a.id===u.accountId);return u.enabled!==false&&a?.enabled!==false&&a?.inferenceEnabled!==false&&(includeBlocked||!isWorkBuddyBlocked(this,u.accountId));});
    const base=route.targets[0],primary=this.config.value.upstreams.find(u=>u.id===base.upstreamId);
    if(primary?.kind!=='workbuddy')throw new AppError('WorkBuddy account pool requires a WorkBuddy primary target',400,'invalid_account_pool');
    const targets=route.accountPool.accountIds.map(accountId=>{
      const primaryAccount=this.config.value.accounts.find(a=>a.id===primary.accountId);
      const account=this.config.value.accounts.find(a=>a.id===accountId&&a.enabled!==false&&a.inferenceEnabled!==false&&a.platform==='workbuddy'&&workBuddyEdition(a)===workBuddyEdition(primaryAccount)&&(includeBlocked||!isWorkBuddyBlocked(this,a.id)));
      const u=account&&this.config.value.upstreams.find(u=>u.kind==='workbuddy'&&u.accountId===accountId&&u.enabled!==false);
      return u?{upstreamId:u.id,model:base.model,accountId}:undefined;
    }).filter(Boolean);
    const preferred=this.get('wb-pool-route:'+route.id)?.preferredAccountId;
    if(preferred)targets.sort((a,b)=>Number(b.accountId===preferred)-Number(a.accountId===preferred));
    return ignoreCooldown?targets:targets.filter(t=>(this.get('wb-pool-cooldown:'+t.accountId)?.until??0)<=Date.now());
  }
  version(route){return this.get('wb-pool-route:'+route.id)?.manualVersion??0;}
  success(route,target,{expectedVersion}={}){if(route.accountPool?.enabled){const manualVersion=this.version(route);if(expectedVersion!==undefined&&expectedVersion!==manualVersion)return;this.set('wb-pool-route:'+route.id,{preferredAccountId:target.accountId,manualVersion,updatedAt:new Date().toISOString()});}}
  exhausted(route,target,error){
    if(!route.accountPool?.enabled||!isCreditExhausted(error))return false;
    const until=Date.now()+(route.accountPool.cooldownSeconds??3600)*1000;
    this.set('wb-pool-cooldown:'+target.accountId,{until,reason:'credits_exhausted'});
    this.ledger?.record({day:new Date().toISOString().slice(0,10),platform:'workbuddy',accountId:target.accountId,task:'model-account-switch',status:'credits_exhausted',routeId:route.id,nextRequestCanSwitch:true});
    return true;
  }
  select(route,accountId){
    if(!route.accountPool?.enabled)throw new AppError('Enable the WorkBuddy account pool first',409,'pool_disabled');
    const target=this.candidates(route,{ignoreCooldown:true}).find(t=>t.accountId===accountId);
    if(!target)throw new AppError('Account is not an enabled member of this route pool',400,'invalid_pool_account');
    if((this.get('wb-pool-cooldown:'+accountId)?.until??0)>Date.now())throw new AppError('Account credits are cooling down; refresh its balance first',409,'account_credit_cooldown');
    this.set('wb-pool-route:'+route.id,{preferredAccountId:accountId,manualVersion:this.version(route)+1,updatedAt:new Date().toISOString()});return {selected:true,routeId:route.id,accountId,effective:'next_request'};
  }
  revive(accountId){this.set('wb-pool-cooldown:'+accountId,{until:0,reason:'balance_restored'});}
  status(route){return {routeId:route.id,enabled:route.accountPool?.enabled===true,preferredAccountId:this.get('wb-pool-route:'+route.id)?.preferredAccountId??null,accounts:this.candidates(route,{ignoreCooldown:true,includeBlocked:true}).map(t=>{const accountId=t.accountId??this.config.value.upstreams.find(u=>u.id===t.upstreamId)?.accountId,blocked=isWorkBuddyBlocked(this,accountId);return {...t,accountId,...this.get('wb-pool-cooldown:'+accountId),banned:blocked,available:!blocked&&(this.get('wb-pool-cooldown:'+accountId)?.until??0)<=Date.now()};})};}
}
// Read-only participation projection. Directory cache rows in current releases
// have neither freshness nor completeness metadata, so they are advisory only:
// a missing cached item never becomes a new routing veto here.
export function workBuddyParticipation(service,route){
  const value=service.config.value,upstreams=value.upstreams??[],accounts=value.accounts??[],primary=upstreams.find(u=>u.id===route.targets[0]?.upstreamId),edition=workBuddyEdition(accounts.find(a=>a.id===primary?.accountId)),model=route.targets[0]?.model;
  const pool=typeof service.router?.pool?.candidates==='function'?service.router.pool:new WorkBuddyPool(service.config,service.ledger);
  const exact=t=>t.model===model&&upstreams.some(u=>u.id===t.upstreamId&&u.kind==='workbuddy'&&workBuddyEdition(accounts.find(a=>a.id===u.accountId))===edition),targets=pool.candidates(route).filter(exact);
  const id=t=>t.accountId??upstreams.find(u=>u.id===t.upstreamId)?.accountId,unique=items=>[...new Set(items.filter(Boolean))],accountIds=unique(targets.map(id)),configuredAccountIds=unique(route.accountPool?.enabled?route.accountPool.accountIds:route.targets.filter(exact).map(id));
  const excludedAccounts=configuredAccountIds.filter(a=>!accountIds.includes(a)).map(accountId=>{const a=accounts.find(a=>a.id===accountId),cooldown=pool.get?.('wb-pool-cooldown:'+accountId);const reason=!a?'account_missing':a.platform!=='workbuddy'?'platform_mismatch':a.enabled===false?'account_disabled':a.inferenceEnabled===false?'inference_disabled':workBuddyEdition(a)!==edition?'edition_mismatch':isWorkBuddyBlocked(service,accountId)?'account_banned':!upstreams.some(u=>u.kind==='workbuddy'&&u.accountId===accountId&&u.enabled!==false)?'upstream_disabled_or_missing':cooldown?.until>Date.now()?'credit_cooldown':'not_selected_by_runtime';return {accountId,reason,...(reason==='credit_cooldown'?{until:cooldown.until}:{})};});
  const evidence=targets.map(t=>{const cached=service.platforms?.catalogs?.get?.(t.upstreamId),rows=Array.isArray(cached)?cached:null,row=rows?.find(m=>m.id===t.model);return {accountId:id(t),upstreamId:t.upstreamId,model:t.model,catalog:{status:rows?row?'listed_in_cache':'not_listed_in_cache':'not_cached',freshness:'unknown',completeness:'unknown',callableDeclared:typeof row?.callable==='boolean'?row.callable:null,importableDeclared:typeof row?.importable==='boolean'?row.importable:null,generationVerified:false}};});
  return {routeId:route.id,policy:route.accountPool?.enabled?route.accountPool.autoManaged===true?'automatic_same_edition':'explicit_members':route.accountPool?.enabled===false?'explicit_pool_off':'single_account',accountIds,configuredAccountIds,availableCount:accountIds.length,configuredCount:configuredAccountIds.length,excludedAccounts,evidence};
}
export async function configureWorkBuddyPool(service,{routeId,accountIds,enabled=true,cooldownSeconds=3600}) {
  const value=structuredClone(service.config.value),route=value.routes.find(r=>r.id===routeId);
  if(!route)throw new AppError('Unknown route',404,'model_not_found');
  const primary=value.upstreams.find(u=>u.id===route.targets[0].upstreamId);
  if(primary?.kind!=='workbuddy')throw new AppError('Select a WorkBuddy model route',400,'invalid_account_pool');
  const edition=workBuddyEdition(value.accounts.find(a=>a.id===primary.accountId));
  if(!Array.isArray(accountIds)||!accountIds.length||new Set(accountIds).size!==accountIds.length||accountIds.some(id=>!value.accounts.some(a=>a.id===id&&a.platform==='workbuddy'&&a.enabled!==false)))throw new AppError('Select distinct enabled WorkBuddy accounts',400,'invalid_pool_accounts');
  if(accountIds.some(id=>workBuddyEdition(value.accounts.find(a=>a.id===id))!==edition))throw new AppError('WB 帐号池按国内版与国际版分别接力',400,'invalid_pool_edition');
  if(!Number.isInteger(cooldownSeconds)||cooldownSeconds<60||cooldownSeconds>86400)throw new AppError('Cooldown must be 60–86400 seconds',400,'invalid_pool_cooldown');
  for(const id of accountIds)if(!value.upstreams.some(u=>u.kind==='workbuddy'&&u.accountId===id&&u.enabled!==false))throw new AppError('Account needs an enabled WorkBuddy upstream: '+id,400,'pool_upstream_missing');
  // Saving a subset means "these accounts now, keep following new ones".
  // Losing autoManaged here silently froze the pool at today's members.
  route.accountPool={enabled:enabled!==false,accountIds,cooldownSeconds,autoManaged:true};
  await service.config.save(value);return {saved:true,...service.router.pool.status(route)};
}
export async function captureWorkBuddyAccount(service,{id,label},{readCurrent}={}) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id??''))throw new AppError('Use a unique account ID (letters, numbers, hyphen)',400,'invalid_account_id');
  const current=readCurrent?await readCurrent():await new CredentialManager(service.config,{bind:(_id,platform,principal)=>({ok:true,fingerprint:hash(platform+'\0'+principal)})}).read({id:'capture-current',platform:'workbuddy',enabled:true,credentials:{kind:'desktop',file:'auto'}});
  const principalHash=hash('workbuddy\0'+current.principal),value=structuredClone(service.config.value);
  const same=value.accounts.find(a=>a.platform==='workbuddy'&&workBuddyEdition(a)===workBuddyEdition(current)&&service.ledger.principalHash(a.id)===principalHash);
  const accountId=same?.id??id,prior=value.accounts.find(a=>a.id===accountId);
  if(prior&&!same)throw new AppError('Account ID already belongs to another account',409,'account_id_conflict');
  const file=join(service.config.dataDir,'accounts',accountId,'workbuddy-session.json');
  let original;try{original=await readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  const old=original?JSON.parse(original):{},edition=workBuddyEdition(current),snapshot={...old,managedBy:'ai-credit-gateway',credentialVersion:1,platform:'workbuddy',accessToken:current.accessToken,uid:current.uid??current.principal,principal:current.principal,domain:current.domain,edition,expiresAtMs:current.expiresAtMs,...(current.refreshToken?{refreshToken:current.refreshToken}:{}),...(current.refreshExpiresAtMs?{refreshExpiresAtMs:current.refreshExpiresAtMs}:{}),...(current.profileRaw?{profileRaw:current.profileRaw}:{}),updatedAt:new Date().toISOString()};
  await atomicJson(file,snapshot);
  const account={...(prior??{id:accountId,label:label||accountId,platform:'workbuddy',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}),edition,credentials:{kind:'file',file}};
  if(prior)value.accounts[value.accounts.indexOf(prior)]=account;else value.accounts.push(account);
  if(!value.upstreams.some(u=>u.kind==='workbuddy'&&u.accountId===accountId))value.upstreams.push({id:'wb-'+accountId,kind:'workbuddy',accountId,enabled:true});
  syncWorkBuddyPools(value);
  try{await service.config.save(value);}catch(e){if(original)await writeFile(file,original,{mode:0o600});else await rm(file,{force:true});throw e;}
  service.ledger.bind(accountId,'workbuddy',current.principal);service.credentials.cache.delete(accountId);
  return {saved:true,accountId,reusedExisting:!!same,credentialFile:file,tokenReturned:false};
}
