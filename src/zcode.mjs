import {AppError,jsonFetch,hash} from './util.mjs';
import {zcodeValidation} from './browser-session.mjs';
// Read-only native billing discovery. Activity claims remain opt-in and need the native challenge flow.
export async function zcodePreview(credential,{fetchPreview=jsonFetch,version='3.14.4'}={}){
 const mid=credential.identity?.deviceId;if(!mid)throw new AppError('ZCode native telemetry deviceMid is missing',409,'native_device_missing');
 const raw=await fetchPreview(`https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(version)}&platform=win32-x64`,{headers:{Authorization:`Bearer ${credential.accessToken}`,'User-Agent':`ZCode/${version}`,'X-Title':'Z Code@electron','X-ZCode-App-Version':version,'X-Platform':'win32-x64','X-Release-Channel':'stable','X-Client-Language':'zh-CN','X-Client-Timezone':'Asia/Shanghai','X-Device-Mid':mid}});
 return {source:'ZCode native billing preview',plans:raw.data?.plans??[],dailyCheckinVerified:false};
}
export function zcodeHeaders(c) {
 const mid=c.identity?.deviceId;
 if(!mid)throw new AppError('ZCode native device identifier is missing',409,'native_device_missing');
 return {Authorization:`Bearer ${c.accessToken}`,'User-Agent':'ZCode/3.14.4','X-ZCode-App-Version':'3.14.4','X-Platform':'win32-x64','X-Device-Mid':mid};
}
export const zcodeReceiptKey=(c,id)=>'zcode-plan/'+hash(c.principal)+'/'+id;
export async function zcodeBalance(c,{request=jsonFetch}={}) {
 const raw=await request('https://zcode.z.ai/api/v1/zcode-plan/billing/balance',{headers:zcodeHeaders(c)});
 return raw.data;
}
export async function zcodeStatus(c,{ledger,request=jsonFetch}={}) {
 const preview=await zcodePreview(c,{fetchPreview:request});
 const plans=preview.plans.filter(p=>typeof p.plan_id==='string'&&p.plan_id&&Array.isArray(p.entitlements));
 const available=plans.filter(p=>!ledger?.get(zcodeReceiptKey(c,p.plan_id)));
 if(!available.length){
   let receipt=ledger?.get('zcode-confirmed/'+hash(c.principal));
   // Older versions persisted the per-plan receipt before preview disappeared.
   // Reconcile against the server's active plan rather than submit a second claim.
   if(!receipt&&ledger){const balance=await zcodeBalance(c,{request});for(const plan of balance?.plans??[]){
     const prior=ledger.get(zcodeReceiptKey(c,plan.plan_id));
     if(prior?.serverConfirmed&&prior.planId===plan.plan_id){receipt={...prior,reconciled:true,balanceAfter:balance};ledger.set('zcode-confirmed/'+hash(c.principal),receipt);break;}
   }}
   return {known:true,active:false,claimed:plans.length>0||!!receipt,reason:receipt?'no_new_free_plan_after_confirmed_receipt':plans.length?'all_visible_plans_already_confirmed':'no_eligible_free_plan',details:{plans,receipt}};
 }
 return {known:true,active:true,claimed:false,details:{plans:available,kind:'free_plan_not_daily_signin',periods:available.flatMap(p=>p.entitlements.map(e=>e.period))}};
}
export async function zcodeClaim(c,{ledger,profileDir,request=jsonFetch,validate=zcodeValidation}={}) {
 const status=await zcodeStatus(c,{ledger,request});
 const plan=status.details.plans[0];if(!status.active||!plan)throw new AppError('No new free ZCode plan is available',409,'zcode_no_plan');
 const before=await zcodeBalance(c,{request});
 const param=await validate(profileDir,'sgp');
 let raw;
 try {raw=await request('https://zcode.z.ai/api/v1/zcode-plan/billing/claim',{headers:{...zcodeHeaders(c),'X-Aliyun-Captcha-Verify-Param':param,'X-Aliyun-Captcha-Verify-Region':'sgp','Verify-Region':'sgp'},body:{plan_id:plan.plan_id}})}
 catch(e){if(e.code==='business_error'){e.definitiveRejection=true;if(/Business 3007/.test(e.message)){e.actionRequired=true;}}throw e;}
 if(!raw.data?.plan||raw.data.plan.plan_id!==plan.plan_id)throw new AppError('ZCode claim response has no matching plan receipt',502,'zcode_receipt_unconfirmed');
 const after=await zcodeBalance(c,{request});
 const receipt={serverConfirmed:true,planId:plan.plan_id,name:plan.name,entitlements:raw.data.plan.entitlements??plan.entitlements,periods:plan.entitlements.map(e=>e.period),balanceBefore:before,balanceAfter:after};
 ledger?.set(zcodeReceiptKey(c,plan.plan_id),receipt);
 ledger?.set('zcode-confirmed/'+hash(c.principal),receipt);
 return {credit:plan.entitlements.reduce((sum,e)=>sum+(Number(e.grant_units)||0),0),unit:'token',planId:plan.plan_id,details:receipt};
}
