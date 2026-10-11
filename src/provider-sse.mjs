import {AppError} from './util.mjs';

// Bounded OpenAI SSE normalization shared by desktop adapters. Caller fixes the upstream origin.
export async function desktopSseResponse(response,{stream=true,model='',signal,prefix='provider',legacyText=false}={}) {
 const reader=response.body?.getReader();if(!reader)throw new AppError('上游响应为空',502,prefix+'_empty_response');
 const decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='',event='',snapshot='',done=false;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 const close=async()=>{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}};
 async function* records(){
  try {while(!done){if(signal?.aborted)throw new AppError('请求取消或超时',499,'request_cancelled');
   const read=await reader.read();if(read.done){done=true;buffer+=decoder.decode();}else buffer+=decoder.decode(read.value,{stream:true});
   if(buffer.length>1048576)throw new AppError('上游流帧过大',502,prefix+'_frame_too_large');
   let index;while((index=buffer.indexOf('\n'))>=0 || (done&&buffer.length)){
    const line=(index<0?buffer:buffer.slice(0,index)).trim();buffer=index<0?'':buffer.slice(index+1);
    if(line.startsWith('event:')){event=line.slice(6).trim();continue;}if(!line)continue;
    if(!line.startsWith('data:')&&!line.startsWith('{'))continue;
    const raw=line.startsWith('data:')?line.slice(5).trim():line;if(raw==='[DONE]'){done=true;break;}
    let row;try{row=JSON.parse(raw);}catch{throw new AppError('上游流格式错误',502,prefix+'_stream_invalid');}
    const ec=row.error_code??row.error?.code??row.code;
    if(event==='error'||row.error||(row.error_code!=null&&!['','0',0].includes(row.error_code))){
     const status=[401,40100,51100].includes(Number(ec))?401:[403,40300].includes(Number(ec))?403:[429,42900].includes(Number(ec))?429:502;
     throw new AppError('上游返回流内业务错误',status,prefix+'_stream_upstream_error');
    } event='';
    if(row.data && typeof row.data==='object')row=row.data;
    if(legacyText&&typeof row.text==='string'){
     if(row.text==='[DONE]'){done=true;break;}const text=row.text;const content=text.startsWith(snapshot)?text.slice(snapshot.length):text;snapshot=text;
     row={id:'chatcmpl-desktop',object:'chat.completion.chunk',model,choices:[{index:0,delta:{content},finish_reason:null}],...(row.usage?{usage:row.usage}:{})};
    }
    if(Array.isArray(row.choices)||row.usage)yield row;
   }
  }}finally{await close();}
 }
 const iterator=records();let first;try{first=await iterator.next();}catch(error){await close();throw error;}
 if(stream){let pending=first;return new Response(new ReadableStream({async pull(controller){try{
   const result=pending??await iterator.next();pending=null;if(result.done){controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();return;}
   controller.enqueue(encoder.encode('data: '+JSON.stringify(result.value)+'\n\n'));
  }catch(error){controller.error(error);await close();}},async cancel(){await close();await iterator.return();}}),{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'}});}
 const choices=new Map();let usage=null,id='chatcmpl-desktop',size=0;
 for(let item=first;!item.done;item=await iterator.next()){
  const row=item.value;id=row.id??id;usage=row.usage??usage;
  size+=JSON.stringify(row).length;if(size>8*1048576){await iterator.return();throw new AppError('上游非流响应过大',502,prefix+'_response_too_large');}
  for(const choice of row.choices??[]){const i=choice.index??0;let current=choices.get(i);if(!current){current={index:i,message:{role:'assistant',content:''},finish_reason:null,tools:new Map()};choices.set(i,current);}
   const delta=choice.delta??choice.message??{};if(typeof delta.content==='string')current.message.content+=delta.content;
   if(typeof delta.reasoning_content==='string')current.message.reasoning_content=(current.message.reasoning_content??'')+delta.reasoning_content;
   for(const t of delta.tool_calls??[]){const ti=t.index??0;let tool=current.tools.get(ti);if(!tool){tool={id:t.id??'',type:'function',function:{name:'',arguments:''}};current.tools.set(ti,tool);}if(t.id)tool.id=t.id;if(t.function?.name)tool.function.name+=t.function.name;if(t.function?.arguments)tool.function.arguments+=t.function.arguments;}
   current.finish_reason=choice.finish_reason??current.finish_reason;
  }
 }
 return Response.json({id,object:'chat.completion',model,choices:[...choices.values()].map(({tools,...c})=>{if(tools.size)c.message.tool_calls=[...tools.values()];return c;}),...(usage?{usage}:{})});
}
export function desktopCompletionLimit(input,cap){
 const a=input?.max_tokens,b=input?.max_completion_tokens;
 if(a!==undefined&&b!==undefined&&a!==b)throw new AppError('输出上限字段冲突',400,'max_tokens_conflict');
 const value=a??b??cap;if(!Number.isSafeInteger(value)||value<1||value>cap)throw new AppError('输出上限超出网关配置',400,'max_tokens_invalid');return value;
}
