import https from 'node:https';
export const policyUrl='https://build.nvidia.com/api/runtime/content/copy.yaml';
// Observed public Build runtime copy on 2026-10-11. Fallback is labelled snapshot, never live account quota.
export const nvidiaPolicySnapshot={publishedRpm:40,publishedDailyRequests:10000,rateSourceUrl:policyUrl,rateFetchedAt:'2026-10-11T04:00:07.000Z',rateSource:'official_snapshot',rateStale:true,rateDetails:'Rate limits may vary by model and traffic from other users may cause throttling.'};
let cached,flight;
export function parseNvidiaPolicy(data,{now=Date.now()}={}){
 const rate=data?.rateLimits,rpm=/^Up to ([\d,]+) rpm$/i.exec(rate?.requestsPerMinute??''),daily=/^([\d,]+) requests per day$/i.exec(rate?.requestsPerDay??'');
 if(!rpm||!daily)throw Error('NVIDIA public policy schema changed');const n=s=>{const v=Number(s.replaceAll(',',''));if(!Number.isSafeInteger(v)||v<1)throw Error('Invalid published rate');return v};
 return {publishedRpm:n(rpm[1]),publishedDailyRequests:n(daily[1]),rateSourceUrl:policyUrl,rateFetchedAt:new Date(now).toISOString(),rateSource:'official_runtime',rateStale:false,rateDetails:String(rate.details??'').slice(0,1200)};
}
export function fetchNvidiaPolicy({proxyUrl}={}){
 if(proxyUrl&&!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(proxyUrl))return Promise.reject(Error('Invalid policy proxy'));
 return new Promise((resolve,reject)=>{const agent=new https.Agent({proxyEnv:proxyUrl?{HTTPS_PROXY:proxyUrl}:{}}),chunks=[];let size=0;const req=https.get(policyUrl,{agent,signal:AbortSignal.timeout(6000),headers:{Accept:'application/json'}},res=>{if(res.statusCode!==200){res.resume();agent.destroy();reject(Error('Public policy status'));return}res.on('data',b=>{size+=b.length;if(size>65536){req.destroy(Error('Public policy too large'));return}chunks.push(b)});res.on('error',reject);res.on('end',()=>{agent.destroy();try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(Error('Invalid public policy JSON'))}})});req.on('error',()=>{agent.destroy();reject(Error('Public policy unavailable'))})});
}
export async function nvidiaPolicy(credential={},options={}){
 const now=options.now??Date.now();if(!options.refresh&&cached&&now-cached.time<300000)return structuredClone(cached.value);if(flight)return structuredClone(await flight);
 flight=(async()=>{try{const value=parseNvidiaPolicy(await(options.fetchImpl??fetchNvidiaPolicy)({proxyUrl:credential.proxyUrl}),{now});cached={time:now,value};return value}catch{return {...(cached?.value??nvidiaPolicySnapshot),rateStale:true}}})();try{return structuredClone(await flight)}finally{flight=null}
}
