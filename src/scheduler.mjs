import {randomInt} from 'node:crypto';
import {dayIn} from './util.mjs';
export function dailyPlan(now,schedule,jitter=0) {
  // Search local wall-clock minutes. This also handles DST folds/gaps on a future VPS timezone.
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const start=Math.floor(now.getTime()/60000)*60000;
  for(let minute=0;minute<3000;minute++){const at=new Date(start+minute*60000);const parts=Object.fromEntries(fmt.formatToParts(at).map(p=>[p.type,p.value]));
    if(Number(parts.hour)===schedule.hour&&Number(parts.minute)===schedule.minute){const target=at.getTime()+jitter*1000;if(target>now.getTime())return target;}
  }
  throw new Error('Schedule has no next daily time');
}
export class Scheduler {
  constructor(config,claims,ledger){Object.assign(this,{config,claims,ledger});this.timer=null;this.running=false;this.stopped=true;this.jobs=new Set();}
  track(promise){this.jobs.add(promise);void promise.finally(()=>this.jobs.delete(promise)).catch(()=>{});return promise;}
  async tick() {
    if(this.stopped||this.running)return;
    const s=this.config.value.scheduler;if(!s.enabled)return;
    const day=dayIn(new Date(),s.timezone);const signature=JSON.stringify([s.timezone,s.hour,s.minute,s.jitterSeconds,(this.config.value.accounts??[]).map(a=>[a.id,a.enabled,a.tasks])]);let plan=this.ledger.get('schedule-plan');
    if(!plan||plan.day!==day||plan.signature!==signature){const jitter=randomInt(0,s.jitterSeconds+1);const now=new Date();
      const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:s.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
      let target;const start=Math.floor(now.getTime()/60000)*60000-26*3600000;
      for(let i=0;i<52*60;i++){const at=new Date(start+i*60000);if(dayIn(at,s.timezone)!==day)continue;const parts=Object.fromEntries(fmt.formatToParts(at).map(p=>[p.type,p.value]));if(Number(parts.hour)===s.hour&&Number(parts.minute)===s.minute){target=at.getTime()+jitter*1000;break}}
      // A skipped DST wall-clock minute is deferred to the next valid daily time.
      target??=dailyPlan(now,s,jitter);plan={day,signature,at:target,jitterSeconds:jitter};this.ledger.set('schedule-plan',plan);
    }
    const last=this.ledger.get('schedule-last');
    if(Date.now()<plan.at||last?.day===day&&last.signature===signature&&(last.complete||Date.now()-last.at<(s.retryMinutes??60)*60000))return;
    this.running=true;try{const results=await this.claims.all();this.ledger.set('schedule-last',{day,signature,at:Date.now(),complete:results.every(r=>!['error','uncertain','busy','action_required'].includes(r.status)),results:results.map(r=>({accountId:r.accountId,task:r.task,status:r.status}))});}finally{this.running=false;}
  }
  start(){if(!this.stopped)return;this.stopped=false;const tick=()=>this.track(this.tick()).catch(()=>{});this.timer=setInterval(tick,30000);this.timer.unref();void this.track((async()=>{if(this.config.value.scheduler.startup){this.running=true;try{await this.claims.all();}finally{this.running=false;}}await this.tick()})()).catch(()=>{});}
  stop(){this.stopped=true;clearInterval(this.timer);return Promise.allSettled([...this.jobs]);}
}
