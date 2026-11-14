// Never import this module in Electron: run it with the standalone Node runtime.
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {secret,errorView} from '../src/util.mjs';
let service,runtime,refresh,closing=false;
async function close(){if(closing)return;closing=true;clearInterval(refresh);service?.scheduler.stop();await runtime?.close();await service?.close();process.exit(0)}
process.on('disconnect',()=>void close());
process.on('SIGTERM',()=>void close());
process.on('message',m=>{if(m?.type==='shutdown')void close();});
try{
 service=await createService(process.argv[2]);
 // A stable listener port keeps a host-scoped reverse-proxy / context-manager
 // override (~/.config/billion-context/billion-context.json) pinned to this
 // gateway. With an ephemeral port every supervisor restart minted a new host
 // and silently dropped the per-provider context window override. Fall back to
 // an ephemeral port when the preferred one is taken so startup never wedges.
 const preferredPort=Number(process.env.AI_CREDIT_WORKER_PORT??60077);
 const ephemeral=()=>startServer(service,{host:'127.0.0.1',port:0,key:secret(),admin:false});
 if(Number.isInteger(preferredPort)&&preferredPort>0){
   let lastError;
   for(let attempt=0;attempt<5;attempt++){
     try{runtime=await startServer(service,{host:'127.0.0.1',port:preferredPort,key:secret(),admin:false});lastError=undefined;break}
     catch(e){lastError=e;if(e?.code!=='EADDRINUSE')break;await new Promise(r=>setTimeout(r,400))}
   }
   if(!runtime){console.error('worker fixed port '+preferredPort+' unavailable: '+(lastError?.code??lastError?.message));runtime=await ephemeral()}
 }else runtime=await ephemeral();
 let refreshing=false;
 refresh=setInterval(()=>{if(refreshing)return;refreshing=true;void(async()=>{const before=JSON.stringify(service.config.value);await service.config.load();if(before!==JSON.stringify(service.config.value)){service.platforms.catalogs.clear();service.credentials.cache.clear()}})().catch(()=>{}).finally(()=>refreshing=false)},30000);refresh.unref();
 // The desktop background service is the sole scheduler owner.
 process.send?.({type:'ready',baseUrl:runtime.baseUrl,key:runtime.key});
}catch(e){const message=errorView(e).message;console.error(message);process.send?.({type:'error',message});await close();}
