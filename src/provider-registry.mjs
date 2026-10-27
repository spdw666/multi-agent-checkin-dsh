import {AppError} from './util.mjs';
export const independentVideoProviderKinds=new Set(['jimeng','kling','xiaoyunque','hailuo','liblib']);
export const videoDailyProviderKinds=new Set(['vidu','pixverse',...independentVideoProviderKinds]);
export const desktopProviderKinds=new Set(['qoder','codebuddy','workbuddyai','cline','codearts','lobster','raccoon','loomy','opencode',...videoDailyProviderKinds]);
const definitions={qoder:['provider-qoder.mjs','qoderProvider'],codebuddy:['provider-buddy.mjs','codeBuddyProvider'],workbuddyai:['provider-buddy.mjs','workBuddyAIProvider'],cline:['provider-cline.mjs','clineProvider'],codearts:['provider-codearts.mjs','codeartsProvider'],lobster:['provider-lobster.mjs','lobsterProvider'],raccoon:['provider-raccoon.mjs','raccoonProvider'],loomy:['provider-loomy.mjs','loomyProvider'],opencode:['provider-opencode.mjs','openCodeProvider'],vidu:['provider-video-daily.mjs','viduDailyProvider'],pixverse:['provider-video-daily.mjs','pixVerseDailyProvider']};
Object.assign(definitions,{jimeng:['provider-video-independent.mjs','jimengDailyProvider'],kling:['provider-video-independent.mjs','klingDailyProvider'],xiaoyunque:['provider-video-independent.mjs','xiaoyunqueDailyProvider'],hailuo:['provider-video-independent.mjs','hailuoDailyProvider'],liblib:['provider-video-independent.mjs','liblibDailyProvider']});
const loaded=new Map();
export async function desktopProvider(kind){
 if(!desktopProviderKinds.has(kind))return null;
 if(loaded.has(kind))return loaded.get(kind);
 const [file,name]=definitions[kind];let mod;try{mod=await import(new URL('./'+file,import.meta.url))}catch{throw new AppError('桌面平台适配器尚未安装完整',503,'provider_module_missing')}
 const provider=mod[name];if(!provider||typeof provider.resolve!=='function'||typeof provider.models!=='function'||typeof provider.health!=='function')throw new AppError('桌面平台适配器契约待完成',503,'provider_protocol_pending');
 loaded.set(kind,provider);return provider;
}
export function providerCapabilities(provider,health={}){return {...(health.capabilities??{}),checkin:health.checkin?.known===false?null:health.capabilities?.checkin??health.supportsCheckin??provider.supportsCheckin??provider.checkinSupported??provider.descriptor?.checkinSupported??false,inference:health.capabilities?.inference??typeof provider.chat==='function'};}
export function desktopBalance(health={}){
 const b=health.balance??{},number=n=>typeof n==='number'&&Number.isFinite(n)?n:null;
 return {dailyQuotaObserved:b.dailyQuotaObserved===true,dailyCycleDate:typeof b.dailyCycleDate==='string'?b.dailyCycleDate:null,dailyQuota:number(b.dailyQuota),dailyQuotaObservedAt:typeof b.dailyQuotaObservedAt==='string'?b.dailyQuotaObservedAt:null,dailyQuotaSource:typeof b.dailyQuotaSource==='string'?b.dailyQuotaSource:null,value:number(b.value),unit:typeof b.unit==='string'?b.unit:'积分',parts:Array.isArray(b.parts)?b.parts:[],expiresAt:b.expiresAt??null,checkedIn:health.checkin?.kind==='pet_work'?null:health.checkin?.claimed===true||b.checkedIn===true,checkinKind:health.checkin?.kind??null,claimable:typeof health.checkin?.claimable==='boolean'?health.checkin.claimable:null,checkinKnown:health.checkin?.known??health.checkinKnown??null,checkinError:health.checkin?.error??health.checkinError??null,note:b.note??health.note??'',capabilities:health.capabilities??{},credentialStatus:health.credentialStatus??health.status??'unverified',health:{status:health.status??'unverified'}};
}
