import test from 'node:test';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';import {errorView} from '../src/util.mjs';
const {buddyChatRejection}=await import(process.env.TEST_BUDDY_DIAG_MODULE?pathToFileURL(process.env.TEST_BUDDY_DIAG_MODULE).href:new URL('../src/provider-rate-limit.mjs',import.meta.url).href);
const rawSecret='SAMPLE-PRIVATE-RAW-MESSAGE';
const diagnostic=e=>{const m=/\[businessCode=(\d+)\]/.exec(errorView(e).message);return m?Number(m[1]):undefined;};
async function reject(body,status=400){const e=await buddyChatRejection(new Response(JSON.stringify(body),{status}));assert.equal(e.code,'provider_chat_rejected');assert.equal(e.status,status);assert(!JSON.stringify(e).includes(rawSecret));return e;}
for(const code of [6002,11150,11158,11133,11102,987654])for(const value of [code,String(code)])test(`Buddy bounded diagnostic ${JSON.stringify(value)} survives public error serialization without raw text`,async()=>{
 const e=await reject({code:value,message:rawSecret,request:{authorization:rawSecret},url:'https://SAMPLE.invalid/'}),v=errorView(e);
 assert.equal(diagnostic(e),code);assert.match(v.message,new RegExp('\\[businessCode='+code+'\\]'));assert.equal(v.status,400);assert(!JSON.stringify(v).includes(rawSecret));assert(!JSON.stringify(v).includes('SAMPLE.invalid'));
 if(code===6002)assert.equal(e.upstreamCode,6002);else assert.equal(e.upstreamCode,undefined);
});
const wrap=[code=>({error:{data:{code}}}),code=>({error:{code}}),code=>({code}),code=>({data:{error:{data:{code}}}}),code=>({data:{error:{code}}}),code=>({data:{code}})];
for(const [i,make]of wrap.entries())test(`Buddy numeric diagnostic only reads supported structural container ${i}`,async()=>{
 const e=await reject(make(11158));assert.equal(diagnostic(e),11158);assert.equal(e.upstreamCode,undefined);assert.equal(e.rateLimitKind,'unknown');assert.equal(e.rateLimitRetryable,false);
});
for(const code of [11150,11158,987654])test(`Buddy unknown429 diagnostic ${code} does not create retry or usage policy`,async()=>{
 const e=await reject({code},429);assert.equal(diagnostic(e),code);assert.equal(e.upstreamCode,undefined);assert.equal(e.rateLimitKind,'unknown');assert.equal(e.rateLimitRetryable,false);assert.equal(e.retryAfterSeconds,undefined);
});
for(const value of ['11158 '+rawSecret,'1e5',11158.5,-11158,1000000,null])test(`Buddy rejects invalid or unbounded diagnostic ${JSON.stringify(value)}`,async()=>{
 const e=await reject({code:value,message:rawSecret});assert.equal(diagnostic(e),undefined);assert(!errorView(e).message.includes('businessCode='));
});
test('Buddy unknown inner code retains original precedence over known wrapper policy',async()=>{
 const e=await reject({error:{data:{code:987654}},code:6002},429);assert.equal(diagnostic(e),987654);assert.equal(e.upstreamCode,undefined);assert.equal(e.rateLimitKind,'unknown');assert.equal(e.rateLimitRetryable,false);
});
test('Buddy known inner code still controls the original transient429 policy',async()=>{
 const e=await reject({error:{data:{code:6002}},code:987654},429);assert.equal(diagnostic(e),6002);assert.equal(e.upstreamCode,6002);assert.equal(e.rateLimitKind,'transient');assert.equal(e.rateLimitRetryable,true);
});
test('Buddy does not infer numeric diagnostics from arbitrary text or unknown keys',async()=>{
 const e=await reject({message:'11158 '+rawSecret,rawCode:11158,request:{code:11158}});assert.equal(diagnostic(e),undefined);assert.equal(e.upstreamCode,undefined);assert(!errorView(e).message.includes('businessCode='));
});
