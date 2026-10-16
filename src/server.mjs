import {balances} from './balances.mjs';
import {startModelAudit} from './model-audit.mjs';
import {restartDsh} from './dsh-control.mjs';
import {captureWorkBuddyAccount,configureWorkBuddyPool} from './workbuddy-pool.mjs';
import {modelDirectory,importModels,exportModels,withConfigMutation} from './model-directory.mjs';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {workBuddySummary,workBuddyAccountDetails,setWorkBuddyInference,saveWorkBuddySettings,switchWorkBuddyAccount,deleteGatewayAccount} from './workbuddy-management.mjs';
import {markWorkBuddyStatus} from './workbuddy-status.mjs';
import {mergeWorkBuddySessions} from './workbuddy-sessions.mjs';
import {queryWorkBuddyTasks,runWorkBuddyTasks} from './workbuddy-tasks.mjs';
import {startWorkBuddyLogin,pollWorkBuddyLogin,cancelWorkBuddyLogin} from './workbuddy-login.mjs';
import {projectRoot} from './config.mjs';
import {workBuddyRotationStatus,saveWorkBuddyRotation,evaluateWorkBuddyRotation} from './workbuddy-rotation.mjs';
import {previewWorkBuddyImport,importWorkBuddyAccounts,exportWorkBuddyAccounts,updateWorkBuddyAccount} from './workbuddy-transfer.mjs';
import {AppError,errorView} from './util.mjs';
import {collectChat,validateChat} from './openai.mjs';
import {buildActivityContext} from './activity-context.mjs';
import {relayPolicy,validateRelay} from './model-relay.mjs';
import {freeProviderMetadata,freeProviderList,prepareFreeProviderConfig,resolveFreeCredential,freeProviderModels} from './free-providers.mjs';
import {importedRouteId} from './model-directory.mjs';
import {gatewayRequestTimeout} from './request-timeouts.mjs';
import {rateLimitMetadata} from './rate-limit-metadata.mjs';
export {gatewayRequestTimeout} from './request-timeouts.mjs';
function equal(a,b){const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y);}
function authorized(req,token){const h=req.headers.authorization;return typeof h==='string'&&h.startsWith('Bearer ')&&equal(h.slice(7),token);}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
// Every drain wait owns, and then removes, all three competing listeners.
// Promise.race(once(drain), once(close)) retained losing close/error listeners
// for each backpressure cycle in long DSH conversations.
export function waitForResponseDrain(res,signal){
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{res.off('drain',drain);res.off('close',close);res.off('error',error);signal?.removeEventListener('abort',abort);};
    const finish=(e)=>{cleanup();e?reject(e):resolve();},drain=()=>finish(),close=()=>finish(new AppError('Client closed',499,'request_cancelled')),error=e=>finish(e),abort=()=>finish(signal.reason??new AppError('Request cancelled',499,'request_cancelled'));
    if(res.destroyed||res.closed||res.writableEnded)return close();if(signal?.aborted)return abort();
    res.once('drain',drain);res.once('close',close);res.once('error',error);signal?.addEventListener('abort',abort,{once:true});
  });
}
async function readBody(req,limit=4194304,{allowEmpty=false}={}){
  let bytes=0;const chunks=[];
  const tooLarge=size=>new AppError(`Request body exceeds limit (${size} bytes > ${limit} bytes). Increase server.bodyLimitBytes for long DSH conversations; message history was not trimmed.`,413,'body_too_large');
  if(Number(req.headers['content-length'])>limit){req.resume();throw tooLarge(Number(req.headers['content-length']));}
  try{for await(const chunk of req.iterator({destroyOnReturn:false})){bytes+=chunk.length;if(bytes>limit)throw tooLarge(bytes);chunks.push(chunk);}}catch(e){req.resume();throw e;}
  if(allowEmpty&&bytes===0)return {};
  try{return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'))}catch{throw new AppError('Invalid JSON body',400,'invalid_request_error');}
}
export async function startServer(service,{host,port,key,adminKey,admin=true,onShutdown}={}) {
  const version=JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8')).version;
  const cfg=service.config.value.server;host??=cfg.host;port??=cfg.port;key??=service.keys.apiKey;adminKey??=service.keys.adminKey;
  const controllers=new Set();let baseUrl;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    let url;
    try{
      const local=`http://${req.headers.host}`;url=new URL(req.url,local);
      const origin=req.headers.origin;
      // Browsers from another origin cannot use the admin/gateway endpoint, even with a leaked ambient header.
      if(origin&&origin!==local)throw new AppError('Origin rejected',403,'origin_rejected');
      if(req.headers.host!==new URL(baseUrl).host&&req.headers.host!==`localhost:${server.address().port}`)throw new AppError('Host rejected',403,'host_rejected');
      if(req.method==='GET'&&url.pathname==='/health'){return json(res,200,{status:'ok',service:'ai-credit-gateway',version});}
      if(admin&&req.method==='GET'&&['/','/app.js','/styles.css'].includes(url.pathname)){
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1);const content=await readFile(join(projectRoot,'web',name));
        res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"});res.end(content);return;
      }
      if(url.pathname.startsWith('/admin/')){
        if(!admin)throw new AppError('Admin surface is not mounted in this shim',404,'not_found');
        if(!authorized(req,adminKey))throw new AppError('Admin Bearer key required',401,'authentication_error');
        if(req.method==='GET'&&url.pathname==='/admin/free-providers')return json(res,200,{source:{repository:'https://github.com/tashfeenahmed/freellmapi',referenceCommit:freeProviderMetadata.referenceCommit,registeredProviders:freeProviderMetadata.registeredProviders,advertisedProviders:freeProviderMetadata.readmeAdvertisedProviders},checkedAt:freeProviderMetadata.checkedAt,providers:freeProviderList().map(p=>{const accounts=service.config.value.accounts.filter(a=>a.platform==='freeapi'&&a.freeProviderId===p.id);return {...p,configured:accounts.some(a=>a.enabled!==false),accountIds:accounts.map(a=>a.id),missingCredential:!p.keyless&&!accounts.some(a=>a.credentials?.file),credentialStatus:accounts.some(a=>a.enabled!==false)?'configured':accounts.length?'pending_configuration':'not_added'};})});
        if(req.method==='POST'&&url.pathname==='/admin/free-provider-add'){
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw new AppError('Provider credential input requires the local management endpoint',403,'loopback_required');
          const b=await readBody(req),expected=service.config.value,prepared=await prepareFreeProviderConfig(service.config,expected,b),value=prepared.value,a=value.accounts.at(-1),u=value.upstreams.at(-1);a.label=a.name;let credentialStatus='missing',catalog=[],setupError;
          try{
            try{const c=await resolveFreeCredential(a,service.config);credentialStatus=c.credentialStatus;catalog=await freeProviderModels(c,{refresh:true,signal:AbortSignal.timeout(15000)});if(!catalog.some(m=>m.callable&&m.importable))throw new AppError('No verified chat capacity in provider catalog',409,'provider_metadata_unverified');a.enabled=true;u.enabled=true;}catch(e){if([401,403].includes(e.status)&&credentialStatus!=='missing')credentialStatus='rejected';setupError={code:errorView(e).code};}
            const selected=Array.isArray(b.models)?b.models:[];let routesAdded=0;
            if(a.enabled)for(const id of selected){const model=catalog.find(m=>m.id===id&&m.callable&&m.importable);if(!model)throw new AppError('Selected provider model is not verified',400,'invalid_model');value.routes.push({id:importedRouteId(u.id,id),name:a.label+' · '+(model.name??id),enabled:true,targets:[{upstreamId:u.id,model:id}]});routesAdded++;}
            const result=await withConfigMutation(service,async()=>{if(service.config.value!==expected)throw new AppError('Configuration changed during provider verification; reload and retry',409,'configuration_changed');await prepared.persist();return {saved:true,accountId:a.id,upstreamId:u.id,routesAdded,credentialStatus,enabled:a.enabled,setupError};});return json(res,200,result);
          }catch(e){await prepared.rollback();throw e;}
        }
        if(req.method==='GET'&&url.pathname==='/admin/activity-context')return json(res,200,buildActivityContext(service,Object.fromEntries(['range','limit','search','source','model'].map(k=>[k,url.searchParams.get(k)??undefined]))));
        if(req.method==='GET'&&url.pathname==='/admin/model-relay')return json(res,200,service.router.relay.status());
        if(req.method==='POST'&&url.pathname==='/admin/model-relay'){const b=await readBody(req);if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['enabled','reservePercent','reserveCredits','partitions'].includes(k)))throw new AppError('Invalid relay settings',400,'invalid_model_relay');return json(res,200,await withConfigMutation(service,async()=>{const value=structuredClone(service.config.value);value.modelRelay=validateRelay({...relayPolicy(value),...b});await service.config.save(value);return {saved:true,...service.router.relay.status()};}));}
        if(req.method==='GET'&&url.pathname==='/admin/workbuddy/rotation')return json(res,200,await workBuddyRotationStatus(service));
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/rotation'){const b=await readBody(req);return json(res,200,await withConfigMutation(service,()=>saveWorkBuddyRotation(service,b)));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/rotation/evaluate')return json(res,200,await evaluateWorkBuddyRotation(service,await readBody(req,4194304,{allowEmpty:true})));
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/accounts/import/preview')return json(res,200,await previewWorkBuddyImport(service,await readBody(req,16777216)));
        if(req.method==='POST'&&['/admin/workbuddy/accounts/import/commit','/admin/workbuddy/accounts/import'].includes(url.pathname)){const b=await readBody(req,16777216);return json(res,200,await withConfigMutation(service,()=>importWorkBuddyAccounts(service,b)));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/accounts/export')return json(res,200,await exportWorkBuddyAccounts(service,await readBody(req)));
        const wbProfile=/^\/admin\/workbuddy\/accounts\/([^/]+)\/profile$/.exec(url.pathname);
        if(req.method==='POST'&&wbProfile){const b=await readBody(req);return json(res,200,await withConfigMutation(service,()=>updateWorkBuddyAccount(service,decodeURIComponent(wbProfile[1]),b)));}
        const wbInference=/^\/admin\/workbuddy\/accounts\/([^/]+)\/inference$/.exec(url.pathname);
        if(req.method==='POST'&&wbInference){const b=await readBody(req);return json(res,200,await withConfigMutation(service,()=>setWorkBuddyInference(service,decodeURIComponent(wbInference[1]),b)));}
        if(req.method==='GET'&&url.pathname==='/admin/workbuddy/summary')return json(res,200,await workBuddySummary(service,{refresh:['1','true'].includes(url.searchParams.get('refresh')),accountId:url.searchParams.get('accountId')??undefined,includeTasks:true}));
        const wbDetails=/^\/admin\/workbuddy\/accounts\/([^/]+)\/details$/.exec(url.pathname);
        if(req.method==='GET'&&wbDetails)return json(res,200,await workBuddyAccountDetails(service,decodeURIComponent(wbDetails[1]),{refresh:['1','true'].includes(url.searchParams.get('refresh'))}));
        const wbStatus=/^\/admin\/workbuddy\/accounts\/([^/]+)\/mark-status$/.exec(url.pathname);
        if(req.method==='POST'&&wbStatus){const b=await readBody(req);return json(res,200,await withConfigMutation(service,()=>markWorkBuddyStatus(service,decodeURIComponent(wbStatus[1]),b)));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/settings'){const b=await readBody(req);return json(res,200,await withConfigMutation(service,()=>saveWorkBuddySettings(service,b)));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/pool/normalize'){await readBody(req,4194304,{allowEmpty:true});return json(res,200,await withConfigMutation(service,async()=>({...await saveWorkBuddySettings(service,{}),normalized:true,models:(await workBuddySummary(service)).models})));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/login/start')return json(res,200,await startWorkBuddyLogin(service,await readBody(req,4194304,{allowEmpty:true})));
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/login/poll'){const b=await readBody(req);return json(res,200,await withConfigMutation(service,()=>pollWorkBuddyLogin(service,b)));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/login/cancel')return json(res,200,cancelWorkBuddyLogin(service,await readBody(req)));
        const switchAccount=/^\/admin\/workbuddy\/accounts\/([^/]+)\/switch$/.exec(url.pathname);
        if(req.method==='POST'&&switchAccount){const b=await readBody(req,4194304,{allowEmpty:true});return json(res,200,await withConfigMutation(service,()=>switchWorkBuddyAccount(service,decodeURIComponent(switchAccount[1]),b)));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/sessions/merge'){const b=await readBody(req,4194304,{allowEmpty:true});return json(res,200,await mergeWorkBuddySessions(service,b));}
        const deleteAccount=/^\/admin\/accounts\/([^/]+)$/.exec(url.pathname);
        if(req.method==='DELETE'&&deleteAccount){const b=await readBody(req);return json(res,200,await withConfigMutation(service,()=>deleteGatewayAccount(service,decodeURIComponent(deleteAccount[1]),b)));}
        if(req.method==='GET'&&url.pathname==='/admin/workbuddy/tasks')return json(res,200,await queryWorkBuddyTasks(service,{accountId:url.searchParams.get('accountId')??service.ledger.get('wb-management-current')?.accountId}));
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/tasks')return json(res,200,await runWorkBuddyTasks(service,await readBody(req)));
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/capture'){const body=await readBody(req);return json(res,200,await withConfigMutation(service,()=>captureWorkBuddyAccount(service,body)));}
        if(req.method==='GET'&&url.pathname==='/admin/workbuddy/pools')return json(res,200,{routes:service.config.value.routes.filter(r=>r.enabled!==false&&service.config.value.upstreams.find(u=>u.id===r.targets[0].upstreamId)?.kind==='workbuddy').map(r=>service.router.pool.status(r))});
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/pool'){const body=await readBody(req);return json(res,200,await withConfigMutation(service,()=>configureWorkBuddyPool(service,body)));}
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/switch'){const b=await readBody(req),r=service.config.value.routes.find(r=>r.id===b.routeId&&r.enabled!==false);if(!r)throw new AppError('Unknown enabled route',404,'model_not_found');return json(res,200,service.router.pool.select(r,b.accountId));}
        if(req.method==='POST'&&url.pathname==='/admin/restart-dsh')return json(res,200,await restartDsh());
        if(req.method==='GET'&&url.pathname==='/admin/model-tests')return json(res,200,service.ledger.get('model-audit')??{status:'not_started',results:[]});
        if(req.method==='POST'&&url.pathname==='/admin/model-tests')return json(res,202,startModelAudit(service,await readBody(req,4194304,{allowEmpty:true})));
        if(req.method==='GET'&&url.pathname==='/admin/balances')return json(res,200,await balances(service,{refresh:url.searchParams.get('refresh')==='1'}));
        if(req.method==='GET'&&url.pathname==='/admin/usage'){
          const options=Object.fromEntries(['accountId','model','status','from','to','beforeId','limit'].map(k=>[k,url.searchParams.get(k)??'']));
          for(const k of ['from','to'])if(options[k]){const date=new Date(options[k]);if(!Number.isFinite(date.getTime()))throw new AppError('Invalid usage date filter',400,'invalid_date');options[k]=date.toISOString();}
          const report=service.ledger.usage(options);return json(res,200,{...report,balanceChanges:options.accountId?service.ledger.balanceChanges(options.accountId):[]});
        }
        if(req.method==='GET'&&url.pathname==='/admin/config')return json(res,200,service.config.value);
        if(req.method==='GET'&&url.pathname==='/admin/models')return json(res,200,await service.router.models());
        if(req.method==='GET'&&url.pathname==='/admin/model-directory')return json(res,200,await modelDirectory(service,{refresh:url.searchParams.get('refresh')==='1'}));
        if(req.method==='POST'&&url.pathname==='/admin/model-import'){const b=await readBody(req);return json(res,200,await importModels(service,b.items,{enabled:b.enabled!==false}));}
        if(req.method==='POST'&&url.pathname==='/admin/model-export'){const b=await readBody(req);return json(res,200,await exportModels(service,b?.routeIds));}
        if(req.method==='PUT'&&url.pathname==='/admin/config'){
          const expected=service.config.value,value=await readBody(req);await withConfigMutation(service,async()=>{
            if(service.config.value!==expected)throw new AppError('Configuration changed during this request; reload and retry',409,'configuration_changed');
            if(value.dataDir!==service.config.value.dataDir)throw new AppError('Change dataDir with the service stopped',409,'restart_required');
            await service.config.save(value);service.balanceCache?.clear();service.credentials.cache.clear();service.platforms.catalogs.clear();service.platforms.trae.clear();
          });return json(res,200,{saved:true,serverRestartRequired:value.server.host!==host||value.server.port!==port});
        }
        if(req.method==='GET'&&url.pathname==='/admin/records')return json(res,200,{records:service.ledger.records({limit:url.searchParams.get('limit')??100,accountId:url.searchParams.get('accountId')??'',platform:url.searchParams.get('platform')??''})});
        if(req.method==='GET'&&url.pathname==='/admin/state')return json(res,200,{baseUrl,keysFile:service.keysFile,configFile:service.config.file,schedule:service.ledger.get('schedule-plan'),lastRun:service.ledger.get('schedule-last')});
        if(req.method==='POST'&&url.pathname==='/admin/doctor'){
          const results=[];for(const a of service.config.value.accounts){if(a.enabled!==false)results.push(await service.credentials.doctor(a.id));}return json(res,200,{results});
        }
        if(req.method==='POST'&&url.pathname==='/admin/health'){const body=await readBody(req);try{return json(res,200,{accountId:body.accountId,...await service.platforms.health(body.accountId)})}catch(e){return json(res,e.status??502,{accountId:body.accountId,error:errorView(e)})}}
        if(req.method==='POST'&&url.pathname==='/admin/claim'){const b=await readBody(req);return json(res,200,b.accountId?await service.claims.run(b.accountId,b.taskId):{results:await service.claims.all()});}
        if(req.method==='POST'&&url.pathname==='/admin/catalog'){const b=await readBody(req);return json(res,200,{upstreamId:b.upstreamId,models:await service.platforms.models(b.upstreamId,{refresh:true})});}
        if(req.method==='POST'&&url.pathname==='/admin/rebind'){const b=await readBody(req);service.credentials.account(b.accountId);service.ledger.unbind(b.accountId);service.credentials.cache.delete(b.accountId);service.balanceCache?.delete(b.accountId);service.balanceCacheKeys?.delete(b.accountId);return json(res,200,await service.credentials.doctor(b.accountId));}
        if(req.method==='POST'&&url.pathname==='/admin/shutdown'&&onShutdown){json(res,200,{stopping:true});setTimeout(onShutdown,50).unref();return;}
        throw new AppError('Admin endpoint not found',404,'not_found');
      }
      if(!authorized(req,key))throw new AppError('Gateway Bearer key required',401,'authentication_error');
      if(req.method==='GET'&&url.pathname==='/v1/models')return json(res,200,await service.router.models());
      if(req.method==='POST'&&url.pathname==='/v1/chat/completions'){
        // Read live policy on every request, including the private DSH worker after config reload.
        const policy=service.config.value.server;
        const body=validateChat(await readBody(req,policy.bodyLimitBytes??67108864));const controller=new AbortController();controllers.add(controller);
        const timeout=setTimeout(()=>controller.abort(new DOMException('Gateway request deadline exceeded','TimeoutError')),gatewayRequestTimeout(policy,body.model));
        const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnect);
        try {
          const source=!admin?'dsh':['dsh','hermes'].includes(req.headers['x-ai-credit-source'])?req.headers['x-ai-credit-source']:'api';
          const stream=service.router.chat(body,controller.signal,{source});
          if(!body.stream)return json(res,200,await collectChat(stream));
          let first=true;
          for await(const chunk of stream){if(first){first=false;res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});}
            if(!res.write(`data: ${JSON.stringify(chunk)}\n\n`))await waitForResponseDrain(res,controller.signal);
          }
          res.end('data: [DONE]\n\n');return;
        }catch(e){if(controller.signal.aborted&&controller.signal.reason?.name==='TimeoutError')throw new AppError('Gateway request deadline exceeded',504,'request_timeout');throw e;}finally{clearTimeout(timeout);controllers.delete(controller);res.off('close',disconnect);}
      }
      throw new AppError('Endpoint not found',404,'not_found');
    }catch(e){const error=errorView(e),retry=[429,503,504].includes(error.status)&&Number.isFinite(e.retryAfterSeconds)&&e.retryAfterSeconds>=0&&e.retryAfterSeconds<=86400?{retryAfterSeconds:e.retryAfterSeconds}:{};const metadata=rateLimitMetadata(e);if(![429,503,504].includes(error.status)){delete metadata.retryAfterSeconds;delete metadata.retryAfterSource;}const payload={message:error.message,type:error.code,code:error.code,...retry,...metadata,...(Number.isInteger(e.upstreamStatus)&&e.upstreamStatus>=400&&e.upstreamStatus<=599?{upstreamStatus:e.upstreamStatus}:{})};if(res.destroyed)return;if(res.headersSent){res.end(`event: error\ndata: ${JSON.stringify({error:payload})}\n\n`);}else {if(retry.retryAfterSeconds!==undefined)res.setHeader('Retry-After',String(Math.ceil(retry.retryAfterSeconds)));json(res,error.status,{error:payload});}}
  });
  server.headersTimeout=15000;server.requestTimeout=30000;server.keepAliveTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve()})});
  const addr=server.address();baseUrl=`http://${host.includes(':')?'['+host+']':host}:${addr.port}`;
  return {server,baseUrl,key,async close(){for(const c of controllers)c.abort();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
