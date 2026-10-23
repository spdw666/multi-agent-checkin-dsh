import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]??fileURLToPath(new URL('../',import.meta.url)));
const {ConfigStore,validateConfig}=await import(pathToFileURL(join(root,'src/config.mjs')));
function sample(accounts,routes){return {schemaVersion:1,dataDir:'./SAMPLE_DATA',accounts:Array.from({length:accounts},(_,i)=>({id:'SAMPLE_A_'+i,label:'SAMPLE',platform:'workbuddy',edition:'cn',enabled:true,inferenceEnabled:true,credentials:{kind:'file',file:'SAMPLE_PRIVATE_REF_'+i}})),upstreams:Array.from({length:accounts},(_,i)=>({id:'SAMPLE_U_'+i,kind:'workbuddy',accountId:'SAMPLE_A_'+i})),routes:Array.from({length:routes},(_,i)=>({id:'SAMPLE_R_'+i,targets:[{upstreamId:'SAMPLE_U_'+i%accounts,model:'SAMPLE_MODEL'}],accountPool:{accountIds:['SAMPLE_A_'+i%accounts],cooldownSeconds:60}})),server:{host:'127.0.0.1',port:0},scheduler:{enabled:false,startup:false,hour:12,minute:0,jitterSeconds:0,timezone:'Asia/Shanghai'}};}
const rounds=5,warmups=1,median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const hash=x=>createHash('sha256').update(x).digest('hex');
const temp=await mkdtemp(join(tmpdir(),'gateway-config-benchmark-'));
try{
 const value=sample(29,83),text=JSON.stringify(value),file=join(temp,'SAMPLE.json');await writeFile(file,text);const store=new ConfigStore(file);
 async function measure(name,iterations,work){const samples=[];let result;for(let r=0;r<warmups+rounds;r++){const start=performance.now();for(let i=0;i<iterations;i++)result=await work();const ms=performance.now()-start;if(r>=warmups)samples.push(ms);}return {name,iterations,samplesMs:samples,medianMs:median(samples),resultSha256:hash(JSON.stringify(result))};}
 const loads=await measure('load_fresh_file_same_content',500,()=>store.load());
 const gates=await measure('final_inference_gate_fresh_file',500,()=>store.workBuddyInferenceAllowed('SAMPLE_A_0'));
 const largeText=JSON.stringify(sample(500,1500));
 const indexed=await measure('validate_large_reference_graph',30,()=>validateConfig(JSON.parse(largeText),{lenient:true}));
 console.log(JSON.stringify({root,node:process.version,input:{accounts:29,routes:83,configBytes:Buffer.byteLength(text),configSha256:hash(text),largeAccounts:500,largeRoutes:1500,largeConfigSha256:hash(largeText),warmups,rounds},checks:{loadedEqualsInput:JSON.stringify(await store.load())===text,inferenceAllowed:await store.workBuddyInferenceAllowed('SAMPLE_A_0')},measurements:[loads,gates,indexed]},null,2));
}finally{const rel=relative(resolve(tmpdir()),resolve(temp));if(!rel||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw Error('SAMPLE_TEMP_OUTSIDE_ROOT');await rm(temp,{recursive:true,force:true,maxRetries:5});}
