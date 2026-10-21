import {setTimeout as sleep} from 'node:timers/promises';
import {dayIn,errorView} from './util.mjs';

// Acknowledgement is not settlement. These are READ-only rechecks, never POST
// retries. The scheduler owns durable, per-task backoff across later attempts.
const confirmationDelays=[0,300,1200];
export class ClaimService {
  constructor(config,credentials,platforms,ledger){Object.assign(this,{config,credentials,platforms,ledger});}
  async run(accountId,taskId='daily-checkin',context={}) {
    const day=dayIn(new Date(),this.config.value.scheduler.timezone),account=this.config.value.accounts.find(a=>a.id===accountId);
    const automatic=context.trigger==='automatic';
    const base={day,platform:account?.platform??'unknown',accountId,task:taskId,trigger:automatic?'automatic':'manual',triggerSource:automatic?context.source??'scheduler':'direct',operationAttempted:false,automaticOperationConfirmed:false,automaticRewardConfirmed:false};
    let key,reserved=false,reservationId,wrote=false,previousUncertain=false,readOnlyDaily=false,reconcilableDaily=false;
    const finish=(status,result={})=>{
      const provenance={trigger:base.trigger,triggerSource:base.triggerSource,operationAttempted:base.operationAttempted,automaticOperationConfirmed:base.automaticOperationConfirmed,automaticRewardConfirmed:base.automaticRewardConfirmed};
      result={...provenance,...result};
      if(reserved&&this.ledger.finish(key,status,result,reservationId)===false){status='busy';result={...provenance,automaticOperationConfirmed:false,automaticRewardConfirmed:false,reason:'claim_reservation_lost'};}
      const full={...base,status,...result};this.ledger.record(full);return full;
    };
    const confirmed=s=>s?.known===true&&s.claimed===true;
    const observed=s=>s?.known===true&&s.observed===true&&s.claimed!==true;
    const rememberWindow=s=>{if(Number.isFinite(Date.parse(s?.nextClaimAt)))base.nextClaimAt=s.nextClaimAt;};
    const rememberConfirmationDay=s=>{
      const officialDay=s?.day??s?.details?.dailyCycleDate;
      // A batch may span midnight. Use an explicit official day only when it
      // matches the wall clock at confirmation; never credit a future receipt.
      if(officialDay===dayIn(new Date(),this.config.value.scheduler.timezone))base.day=officialDay;
    };
    const errorResult=e=>({reason:e.code??'upstream_error',error:errorView(e),...(Number.isFinite(Number(e.retryAt))?{retryAt:Number(e.retryAt)}:Number.isFinite(Date.parse(e.retryAt))?{retryAt:e.retryAt}:{}),...(Number.isFinite(e.retryAfterMs)&&e.retryAfterMs>=0?{retryAfterMs:e.retryAfterMs}:{}),...(e.loginRequired===true||e.status===401?{loginRequired:true}:{})});
    try {
      if(!account||account.enabled===false)return finish('skipped',{reason:'account_disabled'});
      const task=account.tasks?.find(t=>t.id===taskId);if(!task?.enabled)return finish('skipped',{reason:'task_disabled'});
      const c=await this.credentials.resolve(accountId);
      const mode=await this.platforms.dailyReconciliationMode?.(accountId,taskId);
      readOnlyDaily=account.platform==='raccoon'&&taskId==='daily-quota'&&mode==='native-session-get';
      reconcilableDaily=readOnlyDaily||account.platform==='loomy'&&taskId==='daily-quota'&&mode==='idempotent-first-login';
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
      const finishObserved=result=>finish('observed',{...result,...(datedObservation?{observationSchema:1,observationVerifiedDay:base.day}:{})});
      if(!reserved&&!reservation.done)return finish('busy',{reason:'another_worker'});
      before??=await this.platforms.status(accountId,taskId);rememberWindow(before);
      if(before.known!==true)return finish(previousUncertain&&!reconcilableDaily?'uncertain':'error',{reason:'unknown_server_state'});
      if(observed(before))return finishObserved({reason:before.reason,details:before.details,serverConfirmed:true,benefitOutcome:'available_before_run'});
      if(confirmed(before))return finish('already',{reason:before.reason??'server_already_claimed',credits:before.credits,serverConfirmed:true,benefitOutcome:'available_before_run',...(before.details?{details:before.details}:{})});
      // A terminal local receipt does not authorize another submission, even if
      // today's fresh server read disagrees. Expose disagreement, not success.
      if(!reserved)return finish(reservation.status==='rejected'?'rejected':'uncertain',{...(reservation.result??{}),trigger:base.trigger,triggerSource:base.triggerSource,operationAttempted:false,automaticOperationConfirmed:false,automaticRewardConfirmed:false,reason:reservation.status==='rejected'?'previous_definitive_rejection':'local_receipt_conflicts_server_state',serverConfirmed:false});
      const confirmOnly=account.platform==='codearts'&&taskId==='daily-checkin'&&before.pendingConfirmation===true;
      if(previousUncertain&&!confirmOnly&&!reconcilableDaily)return finish('uncertain',{reason:'previous_submission_unconfirmed',serverState:'not_claimed'});
      if(!before.active)return finish('not_available',{reason:before.reason??'activity_inactive'});
      if(before.deviceOccupied)return finish('device_occupied',{reason:'device_daily_limit'});
      if(reservationId&&!this.ledger.markSubmitted(key,reservationId))return finish('busy',{reason:'claim_reservation_lost'});
      wrote=!readOnlyDaily;base.operationAttempted=true;let claim,submissionError,lastError,after;
      try{claim=await this.platforms.claim(accountId,taskId,confirmOnly?{confirmOnly:true}:{});}
      catch(e){if(e.beforeSubmission||e.definitiveRejection||e.actionRequired)throw e;submissionError=e;}
      const execution=()=>{
        const details=claim?.details;
        // first-login's alreadyProcessed describes initialization, not a
        // standalone daily credit transaction. Do not infer a new grant from it.
        const newlyGranted=account.platform!=='loomy'&&!confirmOnly&&!submissionError&&claim?.submitted===true&&claim?.alreadyClaimed!==true&&claim?.claimed===true;
        const performed=claim?.automaticPerformed===true||!submissionError&&(confirmOnly?claim?.submitted===true&&claim?.confirmed===true:claim?.submitted!==false&&claim!==undefined);
        return {automaticOperationConfirmed:automatic&&performed,automaticRewardConfirmed:automatic&&newlyGranted,benefitOutcome:readOnlyDaily&&claim?.automaticPerformed===true?'daily_validity_extended':newlyGranted?'newly_granted':account.platform==='loomy'&&details?.dailyQuotaAlreadyProcessed===false?'first_login_newly_processed':details?.dailyQuotaAlreadyProcessed===true||claim?.alreadyClaimed===true?'already_processed':'confirmed_without_new_reward_proof',...(typeof claim?.submitted==='boolean'?{submitted:claim.submitted}:{}),...(typeof claim?.mutation==='boolean'?{mutation:claim.mutation}:{}),...(typeof claim?.automaticPerformed==='boolean'?{automaticPerformed:claim.automaticPerformed}:{}),...(typeof claim?.alreadyProcessed==='boolean'?{alreadyProcessed:claim.alreadyProcessed}:{}),...(claim?.operation?{operation:claim.operation}:{}),...(claim?.source?{operationSource:claim.source}:{})};
      };
      for(const delay of confirmationDelays){
        if(delay)await sleep(delay);
        try{after=await this.platforms.status(accountId,taskId);lastError=undefined;rememberWindow(after);}
        catch(e){lastError=e;continue;}
        if(observed(after)||confirmed(after))rememberConfirmationDay(after);
        if(observed(after)&&(claim?.observed===true||previousUncertain||submissionError))return finishObserved({...execution(),reason:after.reason??claim?.reason??'server_auto_daily_quota',claimed:false,officialRefreshConfirmed:true,...(after.details??claim?.details?{details:{...claim?.details,...after.details}}:{}),...(submissionError?{reconciledAfterError:true}:{})});
        if(confirmed(after)){
          if(account.platform==='workbuddy')this.ledger.set('wb-pool-cooldown:'+accountId,{until:0,reason:'checkin_confirmed'});
          return finish('success',{...execution(),credits:claim?.credit??after.credits,serverConfirmed:true,...(submissionError?{reconciledAfterError:true}:{}),...(claim?.unit?{unit:claim.unit}:{}),...(claim?.planId?{planId:claim.planId,details:claim.details}:{})});
        }
      }
      return finish('uncertain',{reason:'claim_response_not_confirmed',...(submissionError||lastError?{error:errorView(submissionError??lastError)}:{}),confirmationChecks:confirmationDelays.length});
    }catch(e){
      // Failed reads must never turn uncertainty into a retryable write.
      const status=previousUncertain&&!reconcilableDaily?'uncertain':e.actionRequired?'action_required':e.definitiveRejection?'rejected':wrote&&!e.beforeSubmission?'uncertain':'error';
      return finish(status,errorResult(e));
    }
  }
  async all({tasks}={},context={}) {
    const selected=tasks===undefined?null:new Set(tasks.map(t=>JSON.stringify([t.accountId,t.task??t.taskId])));
    const accounts=this.config.value.accounts.filter(a=>a.enabled!==false),rows=new Array(accounts.length);let next=0;
    // Bounded account concurrency; tasks belonging to one account stay ordered.
    const worker=async()=>{while(next<accounts.length){const i=next++,a=accounts[i];rows[i]=[];for(const t of a.tasks??[])if(t.enabled&&(!selected||selected.has(JSON.stringify([a.id,t.id]))))rows[i].push(await this.run(a.id,t.id,context));}};
    await Promise.all(Array.from({length:Math.min(2,accounts.length)},worker));return rows.flat();
  }
}
