import {randomUUID} from 'node:crypto';
import {DsmlStreamBuffer} from '../vendor/workbuddy-core.mjs';
import {AppError} from './util.mjs';
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
export async function* normalizeChat(response,{model,recovery}={}) {
  const id='chatcmpl-'+randomUUID(),created=Math.floor(Date.now()/1000);
  const chunk=choices=>({id,object:'chat.completion.chunk',created,model,choices});
  const type=response.headers.get('content-type')??'';
  if(type.includes('application/json')) {
    const json=await response.json();if(json.error||json.code&&json.code!==0||!Array.isArray(json.choices)||!json.choices.length)throw new AppError(json.error?.message??`Invalid upstream JSON (code ${json.code??'none'})`,502,'upstream_business_error');
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
    if(event.event==='error'||source.error||source.code!==undefined&&![0,'0'].includes(source.code))throw new AppError(source.error?.message??source.msg??source.message??`Upstream SSE code ${source.code}`,502,'upstream_stream_error');
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
