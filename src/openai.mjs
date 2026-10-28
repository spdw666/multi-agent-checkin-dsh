import {randomUUID} from 'node:crypto';
import {DsmlStreamBuffer} from '../vendor/workbuddy-core.mjs';
import {AppError} from './util.mjs';
import {workBuddyChannelError} from './workbuddy-channel.mjs';
// Context pressure is request-specific, not a wallet or authentication failure.
// Prefer structured codes and exclude explicit rate limits before text matching.
export function isContextWindowError(error={}) {
  if(Number(error.status)===429)return false;
  const code=String(error.code??error.type??error.error?.code??'');
  if(/^(?:context_length_exceeded|context_window_exceeded|model_context_window_exceeded|request_too_large|relay_context_incompatible)$/i.test(code))return true;
  const message=String(error.message??error.error?.message??'');
  if(/rate limit|too many requests|throttl/i.test(message))return false;
  return /context (?:window|length).*(?:exceed|overflow|limit)|(?:exceed|overflow).*(?:context window|context length)|prompt (?:is )?too long|input(?: token count| length)?.*(?:exceed|longer than|too (?:long|large))|maximum (?:context|prompt) length|请求.*上下文.*(?:超|溢)|上下文.*(?:超限|溢出)/i.test(message);
}
function upstreamError(source,fallbackCode,provider,upstreamStatus){
  const detail=source.error??source,message=detail.message??source.msg??source.message??`Upstream code ${source.code??'none'}`;
  if(provider==='workbuddy'){const channel=workBuddyChannelError(source,{status:detail.status??source.status??400,upstreamStatus});if(channel)return channel;}
  const original={message,code:detail.code??detail.type??source.code,status:detail.status??source.status};
  if(isContextWindowError(original))return new AppError(message,400,'context_length_exceeded');
  return new AppError(message,502,fallbackCode);
}
// Some compatible gateways return SSE with application/json. Inspect only the
// leading framing bytes and replay them unchanged; never consume/drop a token.
async function responseFraming(response,declared){
  if(!response.body)return {response,type:declared};
  const reader=response.body.getReader(),prefix=[],decoder=new TextDecoder();let text='',ended=false,type=declared,released=false;
  const release=()=>{if(!released){released=true;reader.releaseLock();}};
  try{
    while(text.length<1024){const next=await reader.read();if(next.done){ended=true;break;}prefix.push(next.value);text+=decoder.decode(next.value,{stream:true});const lead=text.trimStart();if(/^(?:data:|event:|:)/.test(lead)){type='text/event-stream';break;}if(/^[\[{]/.test(lead)){type='application/json';break;}if(lead&&!['data:','event:'].some(p=>p.startsWith(lead))){break;}}
    let i=0;const body=new ReadableStream({async pull(controller){try{if(i<prefix.length){controller.enqueue(prefix[i++]);return;}if(ended){release();controller.close();return;}const next=await reader.read();if(next.done){ended=true;release();controller.close();}else controller.enqueue(next.value);}catch(error){release();controller.error(error);}},async cancel(reason){try{await reader.cancel(reason);}finally{release();}}});
    return {response:new Response(body,{status:response.status,headers:response.headers}),type};
  }catch(error){try{await reader.cancel(error);}finally{release();}throw error;}
}
export async function* sseEvents(body,{eventLimit=1048576}={}) {
  if(!body)throw new AppError('Upstream response has no body',502,'empty_response');
  const reader=body.getReader();const decoder=new TextDecoder();let buffer='',event='',data=[];
  const line=l=>{
    if(l===''){const result=data.length?{event,data:data.join('\n')}:undefined;event='';data=[];return result;}
    if(l.startsWith(':'))return;
    const colon=l.indexOf(':');const key=colon<0?l:l.slice(0,colon);const value=colon<0?'':l.slice(colon+1).replace(/^ /,'');
    if(key==='event')event=value;else if(key==='data')data.push(value);
  };
  try {
    for(;;){const {value,done}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      if(buffer.length+data.reduce((n,s)=>n+s.length,0)>eventLimit)throw new AppError('SSE event exceeds limit',502,'sse_event_too_large');
      for(;;){const p=buffer.search(/[\r\n]/);if(p<0)break;if(buffer[p]==='\r'&&p===buffer.length-1&&!done)break;
        const l=buffer.slice(0,p);const consume=buffer[p]==='\r'&&buffer[p+1]==='\n'?2:1;buffer=buffer.slice(p+consume);const result=line(l);if(result)yield result;
      }
      if(done){if(buffer)line(buffer);const result=line('');if(result)yield result;break;}
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function meaningful(chunk) {return chunk.choices?.some(c=>c.finish_reason||c.delta?.content||c.delta?.reasoning_content||c.delta?.reasoning||c.delta?.tool_calls?.length);}
export async function* normalizeChat(response,{model,recovery,provider}={}) {
  const id='chatcmpl-'+randomUUID(),created=Math.floor(Date.now()/1000);
  const chunk=choices=>({id,object:'chat.completion.chunk',created,model,choices});
  let type=response.headers.get('content-type')??'';
  if(type.includes('application/json')||type.includes('text/event-stream'))({response,type}=await responseFraming(response,type));
  if(type.includes('application/json')) {
    const json=await response.json();if(json.error||json.code&&json.code!==0||!Array.isArray(json.choices)||!json.choices.length)throw upstreamError(json,'upstream_business_error',provider,response.status);
    for(const c of json.choices){const msg=c.message??c.delta;if(!msg)throw new AppError('JSON choice lacks message',502,'invalid_upstream_response');yield chunk([{index:c.index??0,delta:msg,finish_reason:null}]);yield chunk([{index:c.index??0,delta:{},finish_reason:c.finish_reason??(msg.tool_calls?.length?'tool_calls':'stop')}]);}
    if(json.usage)yield {...chunk([]),usage:json.usage};return;
  }
  if(!type.includes('text/event-stream'))throw new AppError('Expected upstream SSE or JSON',502,'invalid_content_type');
  let done=false, finished=false, seen=false, committed=false, count=0,bytes=0;
  let pending=[];const buffers=new Map();const native=new Set();const recoveredCounts=new Map();const finishedChoices=new Map();
  const transform=source=>{
    const result={...source,id,object:'chat.completion.chunk',created,model};delete result.code;
    result.choices=(source.choices??[]).map(c=>({...c,index:c.index??0,delta:{...(c.delta??c.message??{})}}));
    for(const c of result.choices){const index=c.index;
      if(c.delta.tool_calls?.length)native.add(index);
      if(recovery&&typeof c.delta.content==='string'&&!native.has(index)){
        if(!buffers.has(index))buffers.set(index,new DsmlStreamBuffer(recovery));
        const o=buffers.get(index).add(c.delta.content);c.delta.content=o.text;
        if(o.calls?.length){const base=recoveredCounts.get(index)??0;c.delta.tool_calls=o.calls.map((call,i)=>({index:base+i,id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}));recoveredCounts.set(index,base+o.calls.length);}
      }
      if(c.finish_reason){
        const residual=buffers.get(index)?.flush();if(residual?.text)c.delta.content=(c.delta.content??'')+residual.text;
        finished=true;finishedChoices.set(index,c.finish_reason);if(recoveredCounts.get(index))c.finish_reason='tool_calls';
      }
    }
    return result;
  };
  for await(const event of sseEvents(response.body)) {
    if(event.data==='[DONE]'){done=true;break;}
    let source;try{source=JSON.parse(event.data)}catch{throw new AppError('Malformed upstream SSE JSON',502,'malformed_sse')}
    if(event.event==='error'||source.error||source.code!==undefined&&![0,'0'].includes(source.code))throw upstreamError(source,'upstream_stream_error',provider,response.status);
    if(!Array.isArray(source.choices)) {if(source.usage)source.choices=[];else throw new AppError('SSE event lacks choices',502,'invalid_sse_event');}
    const c=transform(source);seen=true;
    // Do not expose a role-only prelude before the upstream commits a usable result.
    if(!committed){pending.push(c);bytes+=JSON.stringify(c).length;count++;
      if(bytes>262144||count>512)throw new AppError('Upstream produced no usable delta',502,'empty_stream');
      if(meaningful(c)){committed=true;for(const row of pending)yield row;pending=[];}
    }else yield c;
  }
  if(!seen||!committed)throw new AppError('Upstream stream contains no answer',502,'empty_stream');
  if(!done&&!finished)throw new AppError('Upstream stream ended before finish/DONE',502,'truncated_stream');
  for(const [index,buffer]of buffers){const out=buffer.flush();if(out.text)yield chunk([{index,delta:{content:out.text},finish_reason:null}]);}
  if(!finished)yield chunk([{index:0,delta:{},finish_reason:recoveredCounts.get(0)?'tool_calls':'stop'}]);
}
export async function collectChat(iterable) {
  let root,usage;const choices=new Map();let bytes=0;
  for await(const chunk of iterable){root??={id:chunk.id,object:'chat.completion',created:chunk.created,model:chunk.model};if(chunk.usage)usage=chunk.usage;
    for(const c of chunk.choices??[]){let row=choices.get(c.index);if(!row){row={index:c.index,message:{role:'assistant',content:''},finish_reason:null,tools:new Map()};choices.set(c.index,row);}
      const d=c.delta??{};if(typeof d.content==='string')row.message.content+=d.content;
      for(const field of ['reasoning_content','reasoning'])if(typeof d[field]==='string')row.message[field]=(row.message[field]??'')+d[field];
      for(const tc of d.tool_calls??[]){const index=tc.index??0;let tool=row.tools.get(index);if(!tool){tool={id:'',type:'function',function:{name:'',arguments:''}};row.tools.set(index,tool);}
        if(tc.id)tool.id+=tc.id;if(tc.type)tool.type=tc.type;if(tc.function?.name)tool.function.name+=tc.function.name;if(tc.function?.arguments)tool.function.arguments+=tc.function.arguments;
      }
      if(c.finish_reason)row.finish_reason=c.finish_reason;
    }
    bytes+=JSON.stringify(chunk).length;if(bytes>32*1048576)throw new AppError('Aggregated response exceeds 32 MiB',502,'response_too_large');
  }
  if(!root)throw new AppError('Empty completion',502,'empty_response');
  return {...root,choices:[...choices.values()].sort((a,b)=>a.index-b.index).map(r=>{if(r.tools.size){r.message.tool_calls=[...r.tools.entries()].sort((a,b)=>a[0]-b[0]).map(([,t])=>t);if(!r.message.content)r.message.content=null;}return {index:r.index,message:r.message,finish_reason:r.finish_reason??'stop'};}),...(usage?{usage}:{})};
}
export function validateChat(request) {
  if(!request||typeof request.model!=='string'||!Array.isArray(request.messages)||!request.messages.length)throw new AppError('model and nonempty messages are required',400,'invalid_request_error');
  for(const m of request.messages)if(!m||!['system','developer','user','assistant','tool'].includes(m.role))throw new AppError('Invalid message role',400,'invalid_request_error');
  if(request.stream!==undefined&&typeof request.stream!=='boolean')throw new AppError('stream must be boolean',400,'invalid_request_error');
  if(request.n!==undefined&&request.n!==1)throw new AppError('Only n=1 is supported',400,'invalid_request_error');
  if(request.tools!==undefined&&(!Array.isArray(request.tools)||request.tools.some(t=>t.type!=='function'||typeof t.function?.name!=='string')))throw new AppError('tools must contain named functions',400,'invalid_request_error');
  return request;
}
