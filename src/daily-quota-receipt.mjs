import {dayIn} from './util.mjs';

// A restart does not undo an official receipt. Restore only a same-principal,
// current-day durable observation, and only alongside a fresh points response.
export function restoreLoomyDailyQuota(health, receipt, now=Date.now()) {
  if(!health?.balance||health.balanceError||health.balance.dailyQuotaObserved===true||!Number.isFinite(health.balance.value))return health;
  const day=dayIn(new Date(now),'Asia/Shanghai'),r=receipt?.result,d=r?.details;
  if(receipt?.status!=='observed'||r?.observationSchema!==1||r.observationVerifiedDay!==day||d?.dailyQuotaObserved!==true||d.dailyCycleDate!==day||d.dailyQuotaSource!=='/api/v1/points/first-login'||!Number.isFinite(d.dailyQuota)||d.dailyQuota<0)return health;
  const stamp=Date.parse(d.dailyQuotaObservedAt);
  if(!Number.isFinite(stamp)||stamp>now||dayIn(new Date(stamp),'Asia/Shanghai')!==day)return health;
  return {...health,balance:{...health.balance,dailyQuotaObserved:true,dailyCycleDate:day,dailyQuota:d.dailyQuota,dailyQuotaObservedAt:d.dailyQuotaObservedAt,dailyQuotaSource:d.dailyQuotaSource}};
}
