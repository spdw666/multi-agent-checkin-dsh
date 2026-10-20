import {setTimeout as sleep} from 'node:timers/promises';
import {dayIn,errorView} from './util.mjs';

// Acknowledgement is not settlement. These are READ-only rechecks, never POST
// retries. The scheduler owns durable, per-task backoff across later attempts.
const confirmationDelays=[0,300,1200];
export class ClaimService {
  constructor(config,credentials,platforms,ledger){Object.assign(this,{config,credentials,platforms,ledger});}
  async run(accountId,taskId='daily-checkin') {
    const day=dayIn(new Date(),this.config.value.scheduler.timezone),account=this.config.value.accounts.find(a=>a.id===accountId);
    const base={day,platform:account?.platform??'unknown',accountId,task:taskId};
    let key,reserved=false,reservationId,wrote=false,previousUncertain=false;
    const finish=(status,result={})=>{
      if(reserved&&this.ledger.finish(key,status,result,reservationId)===false){status='busy';result={reason:'claim_reservation_lost'};}
      const full={...base,status,...result};this.ledger.record(full);return full;
    };
    const confirmed=s=>s?.known===true&&s.claimed===true;
    const observed=s=>s?.known===true&&s.observed===true&&s.claimed!==true;
    const rememberWindow=s=>{if(Number.isFinite(Date.parse(s?.nextClaimAt)))base.nextClaimAt=s.nextClaimAt;};
    const errorResult=e=>({reason:e.code??'upstream_error',error:errorView(e),...(Number.isFinite(Number(e.retryAt))?{retryAt:Number(e.retryAt)}:Number.isFinite(Date.parse(e.retryAt))?{retryAt:e.retryAt}:{}),...(Number.isFinite(e.retryAfterMs)&&e.retryAfterMs>=0?{retryAfterMs:e.retryAfterMs}:{}),...(e.loginRequired===true||e.status===401?{loginRequired:true}:{})});
    try {
      if(!account||account.enabled===false)return finish('skipped',{reason:'account_disabled'});
      const task=account.tasks?.find(t=>t.id===taskId);if(!task?.enabled)return finish('skipped',{reason:'task_disabled'});
      const c=await this.credentials.resolve(accountId);
      // Qoder campaigns roll over at 10:00 CST, not at the ledger's midnight.
      let before;
      if(account.platform==='qoder'){
        before=await this.platforms.status(accountId,taskId);
        if(before.known!==true)return finish('error',{reason:'unknown_server_state'});
        if(before.campaignWindowId)base.campaignWindowId=String(before.day??day)+':'+String(before.campaignWindowId);
        rememberWindow(before);
      }
      key=this.ledger.claimKey(account.platform,c.principalHash,base.campaignWindowId?'campaign:'+base.campaignWindowId:day,taskId,c.identity?.deviceId??'');
      const datedObservation=['loomy','raccoon'].includes(account.platform)&&['daily-quota','daily-checkin'].includes(taskId);
      const reservation=this.ledger.reserve(key,Date.now(),{preparing:true,...(datedObservation?{observationDay:day}:{})});
      reserved=reservation.acquired;reservationId=reservation.reservationId;previousUncertain=reservation.uncertain===true;
      const finishObserved=result=>finish('observed',{...result,...(datedObservation?{observationSchema:1,observationVerifiedDay:day}:{})});
      if(!reserved&&!reservation.done)return finish('busy',{reason:'another_worker'});
      before??=await this.platforms.status(accountId,taskId);rememberWindow(before);
      if(before.known!==true)return finish(previousUncertain?'uncertain':'error',{reason:'unknown_server_state'});
      if(observed(before))return finishObserved({reason:before.reason,details:before.details,serverConfirmed:true});
      if(confirmed(before))return finish('already',{reason:before.reason??'server_already_claimed',credits:before.credits,serverConfirmed:true,...(before.details?{details:before.details}:{})});
      // A terminal local receipt does not authorize another submission, even if
      // today's fresh server read disagrees. Expose disagreement, not success.
      if(!reserved)return finish(reservation.status==='rejected'?'rejected':'uncertain',{...(reservation.result??{}),reason:reservation.status==='rejected'?'previous_definitive_rejection':'local_receipt_conflicts_server_state',serverConfirmed:false});
      const confirmOnly=previousUncertain&&account.platform==='codearts'&&taskId==='daily-checkin'&&before.pendingConfirmation===true;
      if(previousUncertain&&!confirmOnly)return finish('uncertain',{reason:'previous_submission_unconfirmed',serverState:'not_claimed'});
      if(!before.active)return finish('not_available',{reason:before.reason??'activity_inactive'});
      if(before.deviceOccupied)return finish('device_occupied',{reason:'device_daily_limit'});
      if(reservationId&&!this.ledger.markSubmitted(key,reservationId))return finish('busy',{reason:'claim_reservation_lost'});
      wrote=true;let claim,submissionError,lastError,after;
      try{claim=await this.platforms.claim(accountId,taskId,confirmOnly?{confirmOnly:true}:{});}
      catch(e){if(e.beforeSubmission||e.definitiveRejection||e.actionRequired)throw e;submissionError=e;}
      for(const delay of confirmationDelays){
        if(delay)await sleep(delay);
        try{after=await this.platforms.status(accountId,taskId);lastError=undefined;rememberWindow(after);}
        catch(e){lastError=e;continue;}
        if(observed(after)&&(claim?.observed===true||previousUncertain||submissionError))return finishObserved({reason:after.reason??claim?.reason??'server_auto_daily_quota',claimed:false,officialRefreshConfirmed:true,...(after.details??claim?.details?{details:after.details??claim?.details}:{}),...(submissionError?{reconciledAfterError:true}:{})});
        if(confirmed(after)){
          if(account.platform==='workbuddy')this.ledger.set('wb-pool-cooldown:'+accountId,{until:0,reason:'checkin_confirmed'});
          return finish('success',{credits:claim?.credit??after.credits,serverConfirmed:true,...(submissionError?{reconciledAfterError:true}:{}),...(claim?.unit?{unit:claim.unit}:{}),...(claim?.planId?{planId:claim.planId,details:claim.details}:{})});
        }
      }
      return finish('uncertain',{reason:'claim_response_not_confirmed',...(submissionError||lastError?{error:errorView(submissionError??lastError)}:{}),confirmationChecks:confirmationDelays.length});
    }catch(e){
      // Failed reads must never turn uncertainty into a retryable write.
      const status=previousUncertain?'uncertain':e.actionRequired?'action_required':e.definitiveRejection?'rejected':wrote&&!e.beforeSubmission?'uncertain':'error';
      return finish(status,errorResult(e));
    }
  }
  async all({tasks}={}) {
    const selected=tasks===undefined?null:new Set(tasks.map(t=>JSON.stringify([t.accountId,t.task??t.taskId])));
    const accounts=this.config.value.accounts.filter(a=>a.enabled!==false),rows=new Array(accounts.length);let next=0;
    // Bounded account concurrency; tasks belonging to one account stay ordered.
    const worker=async()=>{while(next<accounts.length){const i=next++,a=accounts[i];rows[i]=[];for(const t of a.tasks??[])if(t.enabled&&(!selected||selected.has(JSON.stringify([a.id,t.id]))))rows[i].push(await this.run(a.id,t.id));}};
    await Promise.all(Array.from({length:Math.min(2,accounts.length)},worker));return rows.flat();
  }
}
