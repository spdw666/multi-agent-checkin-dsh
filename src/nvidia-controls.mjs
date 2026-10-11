import {AppError} from './util.mjs';
const gates=new Map();
const cancelled=()=>new AppError('NVIDIA 排队请求已取消',499,'request_cancelled');
function wait(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(cancelled());const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(cancelled())};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},ms);signal?.addEventListener('abort',abort,{once:true})})}
export async function acquireNvidiaSlot(key,settings={},signal){
 const max=settings.maxConcurrent??1,interval=settings.minIntervalMs??1500;if(!Number.isInteger(max)||max<1||max>8||!Number.isInteger(interval)||interval<0||interval>60000)throw new AppError('NVIDIA 本地并发或间隔设置无效',400,'invalid_nvidia_local_limits');
 for(const [id,g] of gates)if(g.active===0&&g.waiting===0&&g.nextAt<=Date.now())gates.delete(id);
 if(gates.size>=128&&!gates.has(key))throw new AppError('本地 NVIDIA 账号队列已满',503,'nvidia_queue_capacity');
 const gate=gates.get(key)??{active:0,nextAt:0,waiting:0};gates.set(key,gate);if(gate.waiting>=64)throw new AppError('NVIDIA 本地等待队列已满',429,'nvidia_local_queue_full');
 gate.waiting++;try{for(;;){if(signal?.aborted)throw cancelled();const now=Date.now();if(gate.active<max&&now>=gate.nextAt){gate.active++;gate.nextAt=now+interval;let released=false;return ()=>{if(!released){released=true;gate.active--}}}await wait(Math.min(Math.max(gate.nextAt-now,20),100),signal)}}finally{gate.waiting--}
}
export async function controlledNvidiaChat(upstream,credential,input,signal,chat){
 const release=await acquireNvidiaSlot(upstream.accountId,upstream.localLimits,signal);let reader;
 try{const result=await chat(upstream,credential,input,signal);if(!result.response.body){release();return result}reader=result.response.body.getReader();const end=()=>{signal?.removeEventListener('abort',abort);release()},abort=()=>{void reader.cancel().catch(()=>{});end()};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const body=new ReadableStream({async pull(controller){try{if(signal?.aborted)throw cancelled();const {done,value}=await reader.read();if(done){end();controller.close()}else controller.enqueue(value)}catch(e){end();controller.error(e)}},async cancel(reason){try{await reader.cancel(reason)}finally{end()}}});return {...result,response:new Response(body,{status:result.response.status,headers:result.response.headers})}}catch(e){release();throw e}
}
