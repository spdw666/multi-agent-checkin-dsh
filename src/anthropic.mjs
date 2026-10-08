import {sseEvents} from './openai.mjs';
import {AppError} from './util.mjs';
export function anthropicBody(r){
 const messages=[],system=[];
 const content=c=>typeof c==='string'?[{type:'text',text:c}]:Array.isArray(c)?c.map(p=>{if(p.type==='text')return p;if(p.type==='image_url'){const u=p.image_url.url,m=/^data:([^;]+);base64,(.*)$/s.exec(u);return {type:'image',source:m?{type:'base64',media_type:m[1],data:m[2]}:{type:'url',url:u}}}throw new AppError('Unsupported content part',400,'unsupported_content')}):[];
 for(const m of r.messages){if(['system','developer'].includes(m.role)){system.push(...content(m.content));continue;}let blocks=content(m.content);if(m.role==='tool')blocks=[{type:'tool_result',tool_use_id:m.tool_call_id,content:typeof m.content==='string'?m.content:JSON.stringify(m.content)}];
 if(m.tool_calls)blocks.push(...m.tool_calls.map(t=>({type:'tool_use',id:t.id,name:t.function.name,input:JSON.parse(t.function.arguments||'{}')})));
 const role=m.role==='assistant'?'assistant':'user';if(messages.at(-1)?.role===role)messages.at(-1).content.push(...blocks);else messages.push({role,content:blocks});}
 const b={model:r.model,messages,max_tokens:r.max_completion_tokens??r.max_tokens??4096,stream:true};if(system.length)b.system=system;
 if(r.temperature!==undefined)b.temperature=r.temperature;if(r.top_p!==undefined)b.top_p=r.top_p;
 if(r.tools?.length&&r.tool_choice!=='none'){b.tools=r.tools.map(t=>({name:t.function.name,description:t.function.description??'',input_schema:t.function.parameters??{type:'object',properties:{}}}));b.tool_choice=r.tool_choice==='required'?{type:'any'}:r.tool_choice?.function?{type:'tool',name:r.tool_choice.function.name}:{type:'auto'};}
 return b;
}
export async function* anthropicChunks(response){
 let stopped=false,tools=false,input=0,output=0;const indexes=new Map();
 for await(const event of sseEvents(response.body)){let d;try{d=JSON.parse(event.data)}catch{throw new AppError('Malformed Anthropic event',502,'malformed_sse')}
 let delta={},finish=null;
 if(d.type==='error')throw new AppError(d.error?.message??'Upstream stream error',502,'upstream_stream_error');
 if(d.type==='message_start'){input=d.message?.usage?.input_tokens??0;delta.role='assistant';}
 else if(d.type==='content_block_start'){let b=d.content_block;if(b.type==='tool_use'){tools=true;const n=indexes.size;indexes.set(d.index,n);delta.tool_calls=[{index:n,id:b.id,type:'function',function:{name:b.name,arguments:Object.keys(b.input??{}).length?JSON.stringify(b.input):''}}];}else if(b.type==='text'&&b.text)delta.content=b.text;}
 else if(d.type==='content_block_delta'){if(d.delta.type==='text_delta')delta.content=d.delta.text;else if(d.delta.type==='thinking_delta')delta.reasoning_content=d.delta.thinking;else if(d.delta.type==='input_json_delta')delta.tool_calls=[{index:indexes.get(d.index),function:{arguments:d.delta.partial_json}}];}
 else if(d.type==='message_delta'){output=d.usage?.output_tokens??output;finish=d.delta?.stop_reason==='tool_use'?'tool_calls':d.delta?.stop_reason==='max_tokens'?'length':d.delta?.stop_reason?'stop':null;}
 else if(d.type==='message_stop'){stopped=true;yield {choices:[],usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output}};break;}
 if(Object.keys(delta).length||finish)yield {choices:[{index:0,delta,finish_reason:finish}]};
 }
 if(!stopped)throw new AppError('Anthropic stream ended before message_stop',502,'truncated_stream');
}
export function openaiResponse(response){const it=anthropicChunks(response)[Symbol.asyncIterator]();return new Response(new ReadableStream({async pull(controller){try{const n=await it.next();if(n.done){controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();}else controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(n.value)+'\n\n'));}catch(e){controller.error(e)}},async cancel(){await it.return?.()}}),{headers:{'Content-Type':'text/event-stream'}});}
