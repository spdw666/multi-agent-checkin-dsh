import {dayIn,errorView} from './util.mjs';
export class ClaimService {
  constructor(config,credentials,platforms,ledger){Object.assign(this,{config,credentials,platforms,ledger});}
  async run(accountId,taskId='daily-checkin') {
    const day=dayIn(new Date(),this.config.value.scheduler.timezone);let account=this.config.value.accounts.find(a=>a.id===accountId);
    const base={day,platform:account?.platform??'unknown',accountId,task:taskId};let key, reserved=false, wrote=false;
    const finish=(status,result={})=>{const full={...base,status,...result};if(reserved)this.ledger.finish(key,status,result);this.ledger.record(full);return full;};
    try {
      if(!account||account.enabled===false)return finish('skipped',{reason:'account_disabled'});
      const task=account.tasks?.find(t=>t.id===taskId);if(!task?.enabled)return finish('skipped',{reason:'task_disabled'});
      const c=await this.credentials.resolve(accountId);
      key=this.ledger.claimKey(account.platform,c.principalHash,day,taskId,c.identity?.deviceId??'');
      const reservation=this.ledger.reserve(key);reserved=reservation.acquired;
      if(!reserved)return finish(reservation.status==='observed'?'observed':reservation.status==='rejected'?'rejected':reservation.done?'already':'busy',{...(reservation.result??{}),originalReason:reservation.result?.reason,reason:reservation.done?'local_idempotency':'another_worker'});
      const before=await this.platforms.status(accountId,taskId);
      if(!before.known)return finish('error',{reason:'unknown_server_state'});
      if(before.observed)return finish('observed',{reason:before.reason,details:before.details});
      if(before.claimed)return finish('already',{reason:before.reason??'server_already_claimed',credits:before.credits,...(before.details?{details:before.details}:{})});
      if(!before.active)return finish('not_available',{reason:before.reason??'activity_inactive'});
      if(before.deviceOccupied)return finish('device_occupied',{reason:'device_daily_limit'});
      // A crash/timeout after submission must not resubmit merely because the local row is stale.
      if(reservation.uncertain)return finish('uncertain',{reason:'previous_submission_unconfirmed',serverState:'not_claimed'});
      wrote=true;const claim=await this.platforms.claim(accountId,taskId);
      const after=await this.platforms.status(accountId,taskId);
      if(!after.claimed)return finish('uncertain',{reason:'claim_response_not_confirmed'});
      if(account.platform==='workbuddy')this.ledger.set('wb-pool-cooldown:'+accountId,{until:0,reason:'checkin_confirmed'});
      return finish('success',{credits:claim.credit??after.credits,serverConfirmed:true,...(claim.unit?{unit:claim.unit}:{}),...(claim.planId?{planId:claim.planId,details:claim.details}: {})});
    }catch(e){return finish(e.actionRequired?'action_required':e.definitiveRejection?'rejected':wrote&&!e.beforeSubmission?'uncertain':'error',{reason:e.code??'upstream_error',error:errorView(e)});}
  }
  async all() {
    const accounts=this.config.value.accounts.filter(a=>a.enabled!==false),rows=new Array(accounts.length);let next=0;
    // Accounts run concurrently (bounded to two); each account's tasks stay sequential.
    const worker=async()=>{while(next<accounts.length){const i=next++,a=accounts[i];rows[i]=[];for(const t of a.tasks??[])if(t.enabled)rows[i].push(await this.run(a.id,t.id));}};
    await Promise.all(Array.from({length:Math.min(2,accounts.length)},worker));return rows.flat();
  }
}
