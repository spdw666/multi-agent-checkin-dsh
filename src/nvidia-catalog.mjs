import snapshot from './nvidia-catalog.snapshot.json' with {type:'json'};
import https from 'node:https';
import {AppError} from './util.mjs';

export const NVIDIA_BUILD_CATALOG_URL='https://build.nvidia.com/models?pageSize=96&filters=nimType%3Anim_type_preview';
const TTL=3600000,MAX_HTML=4*1024*1024;
let cached=null,lastAttempt=0,pending=null;
const documented=new Map(snapshot.models.map(m=>[m.id,m]));
const clone=x=>structuredClone(x);
const positive=n=>Number.isSafeInteger(n)&&n>0;
function objectAt(s,pos){
  const start=s.indexOf('{',pos);if(start<0)return null;
  let depth=0,quote=false,escape=false;
  for(let i=start;i<s.length;i++){const c=s[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;}
    else if(c==='"')quote=true;else if(c==='{')depth++;else if(c==='}'&&!--depth){try{return JSON.parse(s.slice(start,i+1))}catch{return null}}}
  return null;
}
export function nvidiaFlightText(html){
  if(typeof html!=='string'||Buffer.byteLength(html)>MAX_HTML)throw new AppError('NVIDIA Build 目录超过大小上限',502,'nvidia_build_schema');
  let text='';for(const m of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)){
    try{const part=JSON.parse(m[1]);if(part[0]===1&&typeof part[1]==='string')text+=part[1]}catch{}
  }return text;
}
const label=(row,k)=>row.labels?.find(x=>x.key===k)?.values??[];
function category(row,chat){
  if(chat)return 'chat';const terms=[row.name,row.description,...(row.labels??[]).flatMap(x=>x.values??[])].join(' ').toLowerCase();
  if(/embed/.test(terms))return 'embedding';if(/rerank/.test(terms))return 'rerank';
  if(/cosmos3|cosmos-transfer|video|body.pose|active.speaker|streampetr|sparsedrive|bevformer/.test(terms))return 'video';
  if(/voice|speech|audio|tts|\bbnr\b/.test(terms))return 'audio';if(/image|paligemma/.test(terms))return 'image';return 'other';
}
export function parseNvidiaBuildCatalog(html){
  const text=nvidiaFlightText(html);let result=null;
  for(const match of text.matchAll(/"searchResult":\{/g)){const found=objectAt(text,match.index+15);if(Array.isArray(found?.results)&&Number.isInteger(found.resultTotal)){result=found;break}}
  if(!result||result.resultTotal<1||result.resultTotal>1000)throw new AppError('NVIDIA Build 免费目录格式改变',502,'nvidia_build_schema');
  const rows=new Map();for(const r of result.results.flatMap(x=>x.resources??[])){
    if(!label(r,'nimType').includes('Free Endpoint'))continue;
    const publisher=label(r,'publisher')[0],slug=publisher+'/'+r.name;
    if(!/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(slug))continue;
    const chat=label(r,'playgroundType').includes('chat');
    rows.set(slug,{id:slug,buildSlug:slug,name:r.displayName??r.name,description:r.description??'',freeEndpoint:true,chat,category:category(r,chat),
      buildUrl:`https://build.nvidia.com/${slug}/build`,contextWindow:null,maxTokens:null,officialMaxTokens:null,tools:false,multimodal:false,metadataStatus:'limits_unknown'});
  }
  if(rows.size!==result.resultTotal)throw new AppError('NVIDIA Build 免费目录分页不完整',502,'nvidia_build_incomplete');
  return [...rows.values()];
}
export function parseNvidiaBuildMetadata(html,row){
  const text=nvidiaFlightText(html),specPos=text.indexOf('"specifications":'),capPos=text.indexOf('"modelCapability":');
  const spec=specPos>=0?objectAt(text,specPos+17):null,cap=capPos>=0?objectAt(text,capPos+18):null;
  const id=text.match(/"model":\{"type":"string","title":"Model","default":"([^"]+)"/)?.[1]??text.match(/"model":\{"default":"([^"]+)"/)?.[1]??row.id;
  if(!/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(id))return row;
  const schemas=[...text.matchAll(/"max_tokens":\{/g)].map(m=>objectAt(text,m.index+13)).filter(x=>x?.title==='Max Tokens');
  const maximum=schemas.map(x=>x.maximum??x.anyOf?.find(y=>positive(y.maximum))?.maximum).find(positive);
  const defaultOutput=schemas.map(x=>x.default).find(positive);
  const maxTokens=maximum??defaultOutput??null,contextWindow=positive(spec?.contextLength)?spec.contextLength:null;
  const maxTokensSource=maximum?'official_schema':defaultOutput?'configured_default':null;
  return {...row,id,contextWindow,maxTokens,officialMaxTokens:maximum??null,maxTokensSource,
    tools:cap?.functionCalling===true,multimodal:spec?.inputModalities?.includes('Image')===true,
    inputModalities:spec?.inputModalities??[],outputModalities:spec?.outputModalities??[],
    metadataSource:row.buildUrl,limitsSource:row.buildUrl,
    metadataStatus:contextWindow&&maxTokens?(maximum?'documented':'documented_context_configured_output'):'limits_unknown',
    ...(maxTokensSource==='configured_default'?{outputConfigurationNote:'官方 schema 默认值作为本地保守输出配置，不代表官方最大输出'}:{})};
}
export function nvidiaModelMetadata(id){return clone(cached?.models.find(m=>m.id===id)??documented.get(id)??null)}
export function nvidiaCatalogSnapshot(){return clone(snapshot)}
function publicBuildFetch(url,{signal,proxyUrl}={}){
  const u=new URL(url);if(u.origin!=='https://build.nvidia.com'||(u.href!==NVIDIA_BUILD_CATALOG_URL&&!/^\/[a-z0-9._-]+\/[a-z0-9._-]+\/build$/i.test(u.pathname))||u.username||u.password||u.hash)
    throw new AppError('NVIDIA Build 目录地址错误',400,'nvidia_build_endpoint');
  if(proxyUrl&&!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(proxyUrl))throw new AppError('NVIDIA 本机代理地址错误',400,'nvidia_proxy_invalid');
  const agent=new https.Agent({proxyEnv:proxyUrl?{HTTPS_PROXY:proxyUrl}:{}});
  return new Promise((resolve,reject)=>{
    const req=https.get(u,{agent,signal,headers:{Accept:'text/html'}},res=>{
      let size=0;const parts=[];res.setTimeout(10000,()=>req.destroy(Error('timeout')));
      res.on('data',c=>{size+=c.length;if(size>MAX_HTML)req.destroy(Error('size'));else parts.push(c)});
      res.on('error',reject);res.on('end',()=>{agent.destroy();if(res.statusCode!==200)reject(Error('build status'));else resolve(new Response(Buffer.concat(parts)))});
    });req.setTimeout(15000,()=>req.destroy(Error('timeout')));req.on('error',e=>{agent.destroy();reject(e)});
  });
}
export async function nvidiaFreeCatalog({now=Date.now(),signal,proxyUrl,buildFetchImpl=publicBuildFetch,offline=false,force=false}={}){
  if(offline)return {...nvidiaCatalogSnapshot(),catalogSource:'official_snapshot',stale:false};
  if(!force&&cached&&now-cached.fetchedAt<TTL)return clone(cached);
  if(!force&&lastAttempt&&now-lastAttempt<300000)return {...clone(cached??snapshot),catalogSource:cached?'cached_official_build':'official_snapshot',stale:true};
  if(pending)return clone(await pending);
  lastAttempt=now;
  pending=(async()=>{try{
    const activeSignal=signal??AbortSignal.timeout(45000);
    const response=await buildFetchImpl(NVIDIA_BUILD_CATALOG_URL,{signal:activeSignal,proxyUrl,redirect:'error'});if(!response.ok)throw Error('build status');
    const rows=parseNvidiaBuildCatalog(await response.text());let index=0;
    await Promise.all(Array.from({length:4},async()=>{while(index<rows.length){const i=index++,r=rows[i],prior=snapshot.models.find(x=>x.buildSlug===r.buildSlug);
      if(prior){rows[i]={...r,...clone(prior)};continue;}
      if(r.chat){try{const res=await buildFetchImpl(r.buildUrl,{signal:activeSignal,proxyUrl,redirect:'error'});if(res.ok)rows[i]=parseNvidiaBuildMetadata(await res.text(),r)}catch{}}
    }}));
    cached={schemaVersion:1,source:NVIDIA_BUILD_CATALOG_URL,observedAt:new Date(now).toISOString(),fetchedAt:now,freeEndpointCount:rows.length,models:rows,catalogSource:'official_build',stale:false};return clone(cached);
  }catch{if(signal?.aborted)throw new AppError('NVIDIA 目录请求已取消',499,'request_cancelled');return {...clone(cached??snapshot),catalogSource:cached?'cached_official_build':'official_snapshot',stale:true}}finally{pending=null}})();
  return clone(await pending);
}
export function mergeNvidiaCatalog(apiRows,catalog){
  const api=new Set(apiRows.map(x=>x?.id).filter(x=>typeof x==='string'&&x.length>0&&x.length<=160));
  const merged=catalog.models.map(row=>{const known=positive(row.contextWindow)&&positive(row.maxTokens),apiListed=api.has(row.id),importable=row.freeEndpoint&&row.chat&&known&&apiListed;
    api.delete(row.id);return {...clone(row),apiListed,importable,callable:importable,verification:'unverified',source:apiListed?'nvidia-build-and-api':'nvidia-build',catalogSource:catalog.catalogSource,catalogObservedAt:catalog.observedAt,catalogStale:catalog.stale,
      unavailableReason:!row.chat?'非聊天端点；当前聊天路由不接入':!apiListed?'免费目录条目未匹配当前官方 API 模型 ID':!known?'官方上下文或输出配置尚待核验':null};});
  for(const id of api)merged.push({id,name:id,category:'other',chat:false,freeEndpoint:false,apiListed:true,importable:false,callable:false,tools:false,multimodal:false,verification:'unverified',metadataStatus:'free_status_unknown',source:'nvidia-official-api',catalogSource:catalog.catalogSource,catalogObservedAt:catalog.observedAt,catalogStale:catalog.stale,unavailableReason:'官方 API 已列出；当前 Build 免费目录未列出，不自动视为免费聊天模型'});
  return merged;
}
