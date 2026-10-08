// Independently implemented after reviewing WorkBuddy2API Panel (MIT).
import {AppError,atomicJson,hash} from './util.mjs';
import {CredentialManager} from './credentials.mjs';
import {join} from 'node:path';

export function isCreditExhausted(error) {
  const status=Number(error.status);
  // Rate limiting, authentication and bad model parameters are not empty wallets.
  if([401,429].includes(status))return false;
  if(status===402)return true;
  return /insufficient credits?|credits? exhausted|out of credits?|not enough credits?|quota (?:exceeded|exhaust)|payment required|积分不足|额度不足|余额不足|积分用完|额度用尽|没有积分/i.test(String(error.message??''));
}
export class WorkBuddyPool {
  constructor(config,ledger){Object.assign(this,{config,ledger});this.memory=new Map();}
  get(key){return this.ledger?.get(key)??this.memory.get(key);}
  set(key,value){if(this.ledger)this.ledger.set(key,value);else this.memory.set(key,value);}
  candidates(route,{ignoreCooldown=false}={}) {
    if(!route.accountPool?.enabled)return route.targets;
    const base=route.targets[0],primary=this.config.value.upstreams.find(u=>u.id===base.upstreamId);
    if(primary?.kind!=='workbuddy')throw new AppError('WorkBuddy account pool requires a WorkBuddy primary target',400,'invalid_account_pool');
    const targets=route.accountPool.accountIds.map(accountId=>{
      const account=this.config.value.accounts.find(a=>a.id===accountId&&a.enabled!==false&&a.platform==='workbuddy');
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
  status(route){return {routeId:route.id,enabled:route.accountPool?.enabled===true,preferredAccountId:this.get('wb-pool-route:'+route.id)?.preferredAccountId??null,accounts:this.candidates(route,{ignoreCooldown:true}).map(t=>{const accountId=t.accountId??this.config.value.upstreams.find(u=>u.id===t.upstreamId)?.accountId;return {...t,accountId,...this.get('wb-pool-cooldown:'+accountId),available:(this.get('wb-pool-cooldown:'+accountId)?.until??0)<=Date.now()};})};}
}
export async function configureWorkBuddyPool(service,{routeId,accountIds,enabled=true,cooldownSeconds=3600}) {
  const value=structuredClone(service.config.value),route=value.routes.find(r=>r.id===routeId);
  if(!route)throw new AppError('Unknown route',404,'model_not_found');
  const primary=value.upstreams.find(u=>u.id===route.targets[0].upstreamId);
  if(primary?.kind!=='workbuddy')throw new AppError('Select a WorkBuddy model route',400,'invalid_account_pool');
  if(!Array.isArray(accountIds)||!accountIds.length||new Set(accountIds).size!==accountIds.length||accountIds.some(id=>!value.accounts.some(a=>a.id===id&&a.platform==='workbuddy'&&a.enabled!==false)))throw new AppError('Select distinct enabled WorkBuddy accounts',400,'invalid_pool_accounts');
  if(!Number.isInteger(cooldownSeconds)||cooldownSeconds<60||cooldownSeconds>86400)throw new AppError('Cooldown must be 60–86400 seconds',400,'invalid_pool_cooldown');
  for(const id of accountIds)if(!value.upstreams.some(u=>u.kind==='workbuddy'&&u.accountId===id&&u.enabled!==false))throw new AppError('Account needs an enabled WorkBuddy upstream: '+id,400,'pool_upstream_missing');
  route.accountPool={enabled:enabled!==false,accountIds,cooldownSeconds};
  await service.config.save(value);return {saved:true,...service.router.pool.status(route)};
}
export async function captureWorkBuddyAccount(service,{id,label},{readCurrent}={}) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id??''))throw new AppError('Use a unique account ID (letters, numbers, hyphen)',400,'invalid_account_id');
  const current=readCurrent?await readCurrent():await new CredentialManager(service.config,{bind:(_id,platform,principal)=>({ok:true,fingerprint:hash(platform+'\0'+principal)})}).read({id:'capture-current',platform:'workbuddy',enabled:true,credentials:{kind:'desktop',file:'auto'}});
  const principalHash=hash('workbuddy\0'+current.principal),value=structuredClone(service.config.value);
  const same=value.accounts.find(a=>a.platform==='workbuddy'&&service.ledger.principalHash(a.id)===principalHash);
  const accountId=same?.id??id,prior=value.accounts.find(a=>a.id===accountId);
  if(prior&&!same)throw new AppError('Account ID already belongs to another account',409,'account_id_conflict');
  const file=join(service.config.dataDir,'accounts',accountId,'workbuddy-session.json');
  await atomicJson(file,{accessToken:current.accessToken,uid:current.uid??current.principal,principal:current.principal,domain:current.domain,expiresAtMs:current.expiresAtMs});
  const account={...(prior??{id:accountId,label:label||accountId,platform:'workbuddy',enabled:true,tasks:[{id:'daily-checkin',enabled:true}]}),credentials:{kind:'file',file}};
  if(prior)value.accounts[value.accounts.indexOf(prior)]=account;else value.accounts.push(account);
  if(!value.upstreams.some(u=>u.kind==='workbuddy'&&u.accountId===accountId))value.upstreams.push({id:'wb-'+accountId,kind:'workbuddy',accountId,enabled:true});
  await service.config.save(value);service.ledger.bind(accountId,'workbuddy',current.principal);service.credentials.cache.delete(accountId);
  return {saved:true,accountId,reusedExisting:!!same,credentialFile:file,tokenReturned:false};
}
