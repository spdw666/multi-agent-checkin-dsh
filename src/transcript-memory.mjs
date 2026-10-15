import {watch,createReadStream} from 'node:fs';
import {readFile,stat,appendFile,copyFile,mkdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {atomicJson} from './util.mjs';
import {memoryRoot} from './model-audit.mjs';
export function visibleMessage(row){
 const p=row.payload;if(row.type!=='response_item'||p?.type!=='message'||!['user','assistant'].includes(p.role))return undefined;
 if(p.role==='assistant'&&!['final','commentary',undefined,null].includes(p.channel))return undefined;
 const text=p.content?.filter(c=>['input_text','output_text','text'].includes(c.type)).map(c=>c.text??'').join('\n');
 if(!text)return undefined;return '## '+(row.timestamp??'')+' / '+p.role+' / '+(p.channel??'')+'\n\n'+text+'\n\n';
}
export async function followVisibleTranscript(){
 const checkpoint=join(memoryRoot,'会话记录源.json');let cfg;try{cfg=JSON.parse(await readFile(checkpoint,'utf8'));}catch{return ()=>{};}
 let stopped=false,timer,running=false;
 const consume=async()=>{if(stopped||running)return;running=true;try{const size=(await stat(cfg.source)).size;if(size<=cfg.offset)return;const chunks=[];for await(const b of createReadStream(cfg.source,{start:cfg.offset,end:size-1}))chunks.push(b);const data=Buffer.concat(chunks),last=data.lastIndexOf(10);if(last<0)return;let output='',count=0;
  for(const line of data.subarray(0,last+1).toString('utf8').split('\n')){if(!line)continue;try{const message=visibleMessage(JSON.parse(line));if(message){output+=message;count++;const images=message.match(/C:[\\/]Users[\\/]ms[\\/]AppData[\\/]Local[\\/]Temp[\\/]codex-clipboard-[0-9a-f-]+\.(?:png|jpe?g)/gi)??[];for(const source of new Set(images)){try{const folder=join(memoryRoot,'会话归档','截图');await mkdir(folder,{recursive:true});await copyFile(source,join(folder,basename(source)));}catch{}}}}catch{}}
  if(output)await appendFile(join(memoryRoot,'会话归档','用户与助手可见消息.md'),output,'utf8');cfg.offset+=last+1;cfg.messages+=count;cfg.updatedAt=new Date().toISOString();await atomicJson(checkpoint,cfg);
 }finally{running=false;}};
 const observer=watch(cfg.source,()=>{clearTimeout(timer);timer=setTimeout(()=>{void consume().catch(()=>{})},300)});observer.unref();await consume();return ()=>{stopped=true;clearTimeout(timer);observer.close();};
}
