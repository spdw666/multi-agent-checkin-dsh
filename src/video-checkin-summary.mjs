import {dayIn} from './util.mjs';
import {videoDailyClaimDay} from './provider-video-daily.mjs';
import {VIDEO_SESSION_RULES} from './video-session-vault.mjs';

const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const text=value=>typeof value==='string'&&/^[a-z0-9_/-]{1,160}$/i.test(value)?value:null;
const website=(kind,value)=>VIDEO_SESSION_RULES[kind]?.origins.includes(value)?value:null;
export const videoSummaryCurrent=(platform,row,timezone='Asia/Shanghai')=>!VIDEO_SESSION_RULES[platform]||row?.dailyCheckin?.day===videoDailyClaimDay(platform,new Date(),timezone);

// A balance is not a daily receipt. Only a fresh official status or a same-key,
// same-principal/day terminal receipt may classify today's check-in. This view
// never reserves a claim, dispatches a write, or relabels manual work automatic.
export function videoCheckinSummary(service,account,health,{now=new Date()}={}){
 const platform=account.platform;
 if(!VIDEO_SESSION_RULES[platform])return {};
 const checkin=health.checkin??{},timezone=service.config.value.scheduler?.timezone??'Asia/Shanghai';
 const day=videoDailyClaimDay(platform,now,timezone),checkedAt=now.toISOString();
 let status='unknown',todayCheckedIn=null,known=false,credits=finite(checkin.credits)?checkin.credits:null;
 let reason=text(checkin.reason),source='official_status',nextClaimAt=typeof checkin.nextClaimAt==='string'&&Number.isFinite(Date.parse(checkin.nextClaimAt))?checkin.nextClaimAt:null;
 if(checkin.error||checkin.known===false){status=checkin.error?'check_failed':'unknown';}
 else if(checkin.known===true){
  if(checkin.claimed===true){status='claimed';todayCheckedIn=true;known=true;}
  else if(checkin.observed===true){status='observed';known=true;}
  else if(checkin.active===false){status='not_available';known=true;}
  else if(checkin.active===true&&checkin.claimed===false){status='claimable';todayCheckedIn=false;known=true;}
 }
 // Vidu has no read-only "claimed today" endpoint. Retain its verified grant
 // response (including zero), but never infer it from a positive balance.
 if(platform==='vidu'&&checkin.known===true&&checkin.claimed===null&&!checkin.error){
  const ledger=service.ledger,fingerprint=ledger?.principalHash?.(account.id);
  const key=fingerprint&&ledger?.claimKey?.(platform,fingerprint,day,'daily-checkin','');
  const prior=key&&ledger?.claimReceipt?.(key),r=prior?.result,receipt=r?.officialDailyReceipt;
  const at=typeof receipt?.checkedAt==='string'?Date.parse(receipt.checkedAt):NaN;
  if(['success','already','observed'].includes(prior?.status)&&r?.serverConfirmed===true&&receipt?.source==='/iam/v1/users/every-day-credit'&&receipt.day===day&&Number.isSafeInteger(receipt.amount)&&receipt.amount>=0&&r.credits===receipt.amount&&Number.isFinite(at)&&at<=now.getTime()&&dayIn(new Date(at),timezone)===day&&
   (receipt.amount>0&&r.claimed===true&&['success','already'].includes(prior.status)||receipt.amount===0&&prior.status==='observed'&&r.claimed===false&&r.benefitOutcome==='no_new_daily_credit')){
   status=receipt.amount>0?'claimed':'observed';todayCheckedIn=receipt.amount>0?true:null;known=true;credits=receipt.amount;source='retained_official_daily_receipt';reason=receipt.amount>0?'official_daily_receipt_retained':'official_daily_zero_receipt_retained';
  }
 }
 const dailyCheckin={day,checkedAt,status,todayCheckedIn,known,reason,credits,nextClaimAt,source};
 return {checkedIn:todayCheckedIn,checkinKnown:known,claimable:status==='claimable'?true:known?false:null,dailyCheckin,checkinReason:reason,nextClaimAt,...(website(platform,health.websiteUrl)?{websiteUrl:health.websiteUrl}:{})};
}
