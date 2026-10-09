import {balances} from './balances.mjs';
import {startModelAudit} from './model-audit.mjs';
import {restartDsh} from './dsh-control.mjs';
import {captureWorkBuddyAccount,configureWorkBuddyPool} from './workbuddy-pool.mjs';
import {modelDirectory,importModels} from './model-directory.mjs';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {once} from 'node:events';
import {projectRoot} from './config.mjs';
import {AppError,errorView} from './util.mjs';
import {collectChat,validateChat} from './openai.mjs';
function equal(a,b){const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y);}
function authorized(req,token){const h=req.headers.authorization;return typeof h==='string'&&h.startsWith('Bearer ')&&equal(h.slice(7),token);}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function readBody(req,limit=4194304,{allowEmpty=false}={}){
  let bytes=0;const chunks=[];
  const tooLarge=size=>new AppError(`Request body exceeds limit (${size} bytes > ${limit} bytes). Increase server.bodyLimitBytes for long DSH conversations; message history was not trimmed.`,413,'body_too_large');
  if(Number(req.headers['content-length'])>limit){req.resume();throw tooLarge(Number(req.headers['content-length']));}
  try{for await(const chunk of req.iterator({destroyOnReturn:false})){bytes+=chunk.length;if(bytes>limit)throw tooLarge(bytes);chunks.push(chunk);}}catch(e){req.resume();throw e;}
  if(allowEmpty&&bytes===0)return {};
  try{return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'))}catch{throw new AppError('Invalid JSON body',400,'invalid_request_error');}
}
export async function startServer(service,{host,port,key,adminKey,admin=true,onShutdown}={}) {
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
      if(req.method==='GET'&&url.pathname==='/health'){return json(res,200,{status:'ok',service:'ai-credit-gateway',version:'0.1.0'});}
      if(admin&&req.method==='GET'&&url.pathname==='/')return json(res,200,{service:'ai-credit-gateway',frontendIncluded:false,docs:'docs/api.md'});
      if(url.pathname.startsWith('/admin/')){
        if(!admin)throw new AppError('Admin surface is not mounted in this shim',404,'not_found');
        if(!authorized(req,adminKey))throw new AppError('Admin Bearer key required',401,'authentication_error');
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/capture')return json(res,200,await captureWorkBuddyAccount(service,await readBody(req)));
        if(req.method==='GET'&&url.pathname==='/admin/workbuddy/pools')return json(res,200,{routes:service.config.value.routes.filter(r=>r.enabled!==false&&service.config.value.upstreams.find(u=>u.id===r.targets[0].upstreamId)?.kind==='workbuddy').map(r=>service.router.pool.status(r))});
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/pool')return json(res,200,await configureWorkBuddyPool(service,await readBody(req)));
        if(req.method==='POST'&&url.pathname==='/admin/workbuddy/switch'){const b=await readBody(req),r=service.config.value.routes.find(r=>r.id===b.routeId&&r.enabled!==false);if(!r)throw new AppError('Unknown enabled route',404,'model_not_found');return json(res,200,service.router.pool.select(r,b.accountId));}
        if(req.method==='POST'&&url.pathname==='/admin/restart-dsh')return json(res,200,await restartDsh());
        if(req.method==='GET'&&url.pathname==='/admin/model-tests')return json(res,200,service.ledger.get('model-audit')??{status:'not_started',results:[]});
        if(req.method==='POST'&&url.pathname==='/admin/model-tests')return json(res,202,startModelAudit(service,await readBody(req,4194304,{allowEmpty:true})));
        if(req.method==='GET'&&url.pathname==='/admin/balances')return json(res,200,await balances(service,{refresh:url.searchParams.get('refresh')==='1'}));
        if(req.method==='GET'&&url.pathname==='/admin/config')return json(res,200,service.config.value);
        if(req.method==='GET'&&url.pathname==='/admin/models')return json(res,200,await service.router.models());
        if(req.method==='GET'&&url.pathname==='/admin/model-directory')return json(res,200,await modelDirectory(service,{refresh:url.searchParams.get('refresh')==='1'}));
        if(req.method==='POST'&&url.pathname==='/admin/model-import'){const b=await readBody(req);return json(res,200,await importModels(service,b.items,{enabled:b.enabled!==false}));}
        if(req.method==='PUT'&&url.pathname==='/admin/config'){
          const value=await readBody(req);if(value.dataDir!==service.config.value.dataDir)throw new AppError('Change dataDir with the service stopped',409,'restart_required');
          await service.config.save(value);service.balanceCache?.clear();service.credentials.cache.clear();service.platforms.catalogs.clear();service.platforms.trae.clear();return json(res,200,{saved:true,serverRestartRequired:value.server.host!==host||value.server.port!==port});
        }
        if(req.method==='GET'&&url.pathname==='/admin/records')return json(res,200,{records:service.ledger.records({limit:url.searchParams.get('limit')??100,accountId:url.searchParams.get('accountId')??'',platform:url.searchParams.get('platform')??''})});
        if(req.method==='GET'&&url.pathname==='/admin/state')return json(res,200,{baseUrl,keysFile:service.keysFile,configFile:service.config.file,schedule:service.ledger.get('schedule-plan'),lastRun:service.ledger.get('schedule-last')});
        if(req.method==='POST'&&url.pathname==='/admin/doctor'){
          const results=[];for(const a of service.config.value.accounts){if(a.enabled!==false)results.push(await service.credentials.doctor(a.id));}return json(res,200,{results});
        }
        if(req.method==='POST'&&url.pathname==='/admin/health'){const body=await readBody(req);try{return json(res,200,{accountId:body.accountId,...await service.platforms.health(body.accountId)})}catch(e){return json(res,e.status??502,{accountId:body.accountId,error:errorView(e)})}}
        if(req.method==='POST'&&url.pathname==='/admin/claim'){const b=await readBody(req);return json(res,200,b.accountId?await service.claims.run(b.accountId,b.taskId):{results:await service.claims.all()});}
        if(req.method==='POST'&&url.pathname==='/admin/catalog'){const b=await readBody(req);return json(res,200,{upstreamId:b.upstreamId,models:await service.platforms.models(b.upstreamId,{refresh:true})});}
        if(req.method==='POST'&&url.pathname==='/admin/rebind'){const b=await readBody(req);service.credentials.account(b.accountId);service.ledger.unbind(b.accountId);service.credentials.cache.delete(b.accountId);return json(res,200,await service.credentials.doctor(b.accountId));}
        if(req.method==='POST'&&url.pathname==='/admin/shutdown'&&onShutdown){json(res,200,{stopping:true});setTimeout(onShutdown,50).unref();return;}
        throw new AppError('Admin endpoint not found',404,'not_found');
      }
      if(!authorized(req,key))throw new AppError('Gateway Bearer key required',401,'authentication_error');
      if(req.method==='GET'&&url.pathname==='/v1/models')return json(res,200,await service.router.models());
      if(req.method==='POST'&&url.pathname==='/v1/chat/completions'){
        // Read live policy on every request, including the private DSH worker after config reload.
        const policy=service.config.value.server;
        const body=validateChat(await readBody(req,policy.bodyLimitBytes??67108864));const controller=new AbortController();controllers.add(controller);
        const timeout=setTimeout(()=>controller.abort(),policy.requestTimeoutMs??180000);
        const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnect);
        try {
          const stream=service.router.chat(body,controller.signal);
          if(!body.stream)return json(res,200,await collectChat(stream));
          let first=true;
          for await(const chunk of stream){if(first){first=false;res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});}
            if(!res.write(`data: ${JSON.stringify(chunk)}\n\n`))await Promise.race([once(res,'drain'),once(res,'close').then(()=>{throw new AppError('Client closed',499,'request_cancelled')})]);
          }
          res.end('data: [DONE]\n\n');return;
        }finally{clearTimeout(timeout);controllers.delete(controller);res.off('close',disconnect);}
      }
      throw new AppError('Endpoint not found',404,'not_found');
    }catch(e){const error=errorView(e);if(res.destroyed)return;if(res.headersSent){res.end(`event: error\ndata: ${JSON.stringify({error:{message:error.message,type:error.code,code:error.code}})}\n\n`);}else json(res,error.status,{error:{message:error.message,type:error.code,code:error.code}});}
  });
  server.headersTimeout=15000;server.requestTimeout=30000;server.keepAliveTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve()})});
  const addr=server.address();baseUrl=`http://${host.includes(':')?'['+host+']':host}:${addr.port}`;
  return {server,baseUrl,key,async close(){for(const c of controllers)c.abort();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
