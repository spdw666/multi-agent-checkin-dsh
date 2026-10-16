// Bounded in-memory ZIP transport. No archive member is ever extracted to disk.
import {inflateRawSync} from 'node:zlib';
import {AppError} from './util.mjs';
export const WB_TRANSFER_LIMITS=Object.freeze({inputBytes:4*1024*1024,expandedBytes:16*1024*1024,jsonBytes:256*1024,entries:256,accounts:128,files:32});
const fail=(code='wb_import_archive_invalid')=>{throw new AppError('WB ZIP 格式、校验或文件边界不符合要求',400,code);};
const decoder=new TextDecoder('utf-8',{fatal:true});
export function decodeWorkBuddyText(bytes){try{return decoder.decode(bytes).replace(/^\uFEFF/,'');}catch{throw new AppError('WB 文件需要有效 UTF-8 文本',400,'wb_import_encoding');}}
const table=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function workBuddyCrc32(bytes){let n=0xffffffff;for(const byte of bytes)n=table[(n^byte)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function validName(name){return name.length>0&&name.length<=240&&!/[\\\0:\x00-\x1f]/.test(name)&&!name.startsWith('/')&&!name.split('/').some(p=>p==='.'||p==='..'||p==='')&&name.normalize('NFC')===name;}
export function readWorkBuddyZip(input){
  const b=Buffer.from(input),L=WB_TRANSFER_LIMITS;if(b.length>L.inputBytes)fail('wb_import_size_limit');
  let end=-1;for(let p=b.length-22;p>=Math.max(0,b.length-65557);p--)if(b.readUInt32LE(p)===0x06054b50&&p+22+b.readUInt16LE(p+20)===b.length){end=p;break;}
  if(end<0)fail();const disk=b.readUInt16LE(end+4),centralDisk=b.readUInt16LE(end+6),count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
  if(disk||centralDisk||count!==b.readUInt16LE(end+8)||count===0xffff||!count||count>L.entries||offset+size!==end)fail();
  let p=offset,total=0;const result=[],names=new Set(),ranges=[];
  for(let i=0;i<count;i++){
    if(p+46>end||b.readUInt32LE(p)!==0x02014b50)fail();
    const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),crc=b.readUInt32LE(p+16),packed=b.readUInt32LE(p+20),unpacked=b.readUInt32LE(p+24),nl=b.readUInt16LE(p+28),el=b.readUInt16LE(p+30),cl=b.readUInt16LE(p+32),start=b.readUInt32LE(p+42),unixType=(b.readUInt32LE(p+38)>>>16)&0xf000;
    if((flags&~0x808)!==0||![0,8].includes(method)||b.readUInt16LE(p+34)||unixType===0xa000||packed===0xffffffff||unpacked===0xffffffff||p+46+nl+el+cl>end)fail();
    const name=decodeWorkBuddyText(b.subarray(p+46,p+46+nl)),folder=name.endsWith('/'),path=folder?name.slice(0,-1):name,key=path.toLowerCase();
    if(!validName(path)||names.has(key)||!folder&&!/\.json$|(?:^|\/)_manifest\.tsv$/i.test(path))fail();names.add(key);
    if(unpacked>(/\.json$/i.test(path)?L.jsonBytes:L.expandedBytes)||total+unpacked>L.expandedBytes)fail('wb_import_size_limit');total+=unpacked;
    if(start+30>offset||b.readUInt32LE(start)!==0x04034b50||b.readUInt16LE(start+6)!==flags||b.readUInt16LE(start+8)!==method)fail();
    const localNameLen=b.readUInt16LE(start+26),localExtraLen=b.readUInt16LE(start+28),dataStart=start+30+localNameLen+localExtraLen,dataEnd=dataStart+packed;
    if(dataStart>offset||dataEnd>offset||decodeWorkBuddyText(b.subarray(start+30,start+30+localNameLen))!==name)fail();
    let rangeEnd=dataEnd;
    if(flags&8){let d=dataEnd;if(d+4<=offset&&b.readUInt32LE(d)===0x08074b50)d+=4;if(d+12>offset||b.readUInt32LE(d)!==crc||b.readUInt32LE(d+4)!==packed||b.readUInt32LE(d+8)!==unpacked)fail();rangeEnd=d+12;}
    else if(b.readUInt32LE(start+14)!==crc||b.readUInt32LE(start+18)!==packed||b.readUInt32LE(start+22)!==unpacked)fail();
    if(ranges.some(([a,z])=>start<z&&rangeEnd>a))fail();ranges.push([start,rangeEnd]);
    let bytes;try{bytes=method===0?Buffer.from(b.subarray(dataStart,dataEnd)):inflateRawSync(b.subarray(dataStart,dataEnd),{maxOutputLength:Math.max(1,unpacked)});}catch{fail();}
    if(bytes.length!==unpacked||workBuddyCrc32(bytes)!==crc||folder&&unpacked)fail();
    if(!folder&&/\.json$/i.test(path))result.push({name,bytes});p+=46+nl+el+cl;
  }
  if(p!==end||!result.length)fail();return result;
}
export function createWorkBuddyZip(entries){
  const parts=[],central=[];let offset=0;
  for(const entry of entries){const name=Buffer.from(entry.name,'utf8'),data=Buffer.from(entry.content,'utf8');if(!validName(entry.name))fail();const crc=workBuddyCrc32(data),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);parts.push(h,name,data);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+data.length;}
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,cd,end]);
}
