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
export async function followVisibleTranscript(){return ()=>{};}
