import test from 'node:test';
import assert from 'node:assert/strict';
import {dayIn,jsonFetch,redact,rememberSecret,errorView,AppError} from '../src/util.mjs';

const oracle=(date,timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
test('day formatter preserves midnight, leap day, DST and fractional timezones',()=>{
 const dates=['2026-10-23T15:59:59Z','2026-10-23T16:00:00Z','2024-02-29T23:30:00Z','2026-03-08T06:59:59Z','2026-03-08T07:00:00Z','2026-11-01T05:59:59Z','2026-11-01T06:00:00Z'];
 for(const tz of ['Asia/Shanghai','UTC','America/New_York','Australia/Lord_Howe','Asia/Kathmandu'])for(const value of dates){const date=new Date(value);assert.equal(dayIn(date,tz),oracle(date,tz));}
});
test('day formatter preserves invalid dates and invalid timezone exceptions',()=>{
 assert.throws(()=>dayIn(new Date(NaN),'UTC'),RangeError);
 assert.throws(()=>dayIn(new Date(),'SAMPLE/Invalid'),RangeError);
 assert.throws(()=>dayIn(new Date(),'SAMPLE/Invalid'),RangeError);
});
test('day formatter preserves non-string timezone coercion without caching object identity',()=>{
 let zone='UTC';const timezone={toString:()=>zone};const date=new Date('2026-10-23T20:00:00Z');
 assert.equal(dayIn(date,timezone),oracle(date,zone));zone='Asia/Shanghai';assert.equal(dayIn(date,timezone),oracle(date,zone));
 assert.throws(()=>dayIn(date,null),RangeError);
});
test('day formatter reuses a repeated timezone constructor',async()=>{
 const fresh=await import('../src/util.mjs?optimization-cache-repeat'),Original=Intl.DateTimeFormat;let constructions=0;
 Intl.DateTimeFormat=function(...args){constructions++;return new Original(...args);};
 try{for(let i=0;i<50;i++)fresh.dayIn(new Date(1700000000000+i*60000),'UTC');assert.equal(constructions,1);}finally{Intl.DateTimeFormat=Original;}
});
test('day formatter cache is bounded and evicts older timezone entries',async()=>{
 const fresh=await import('../src/util.mjs?optimization-cache-bound'),Original=Intl.DateTimeFormat;let constructions=0;
 const zones=Intl.supportedValuesOf('timeZone').slice(0,33),date=new Date('2026-10-23T00:00:00Z');
 Intl.DateTimeFormat=function(...args){constructions++;return new Original(...args);};
 try{for(const zone of zones)fresh.dayIn(date,zone);assert.equal(constructions,33);fresh.dayIn(date,zones.at(-1));assert.equal(constructions,33);fresh.dayIn(date,zones[0]);assert.equal(constructions,34);}finally{Intl.DateTimeFormat=Original;}
});
for(const status of [200,401,403,429,500,503])test(`jsonFetch null HTTP ${status} retains response classification`,async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);globalThis.fetch=async()=>Response.json(null,{status});
 await assert.rejects(jsonFetch('https://sample.invalid'),e=>e instanceof AppError&&e.status===(status===200?502:status)&&e.code==='invalid_upstream_response');
});
test('jsonFetch preserves successful objects, arrays and primitive JSON',async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
 for(const value of [{code:0,data:{ok:true}},[1,2],'ok',123,false]){globalThis.fetch=async()=>Response.json(value);assert.deepEqual(await jsonFetch('https://sample.invalid'),value);}
});
test('jsonFetch preserves upstream HTTP and business errors and non-JSON status',async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
 globalThis.fetch=async()=>Response.json({message:'not authorized'},{status:401});await assert.rejects(jsonFetch('https://sample.invalid'),{status:401,code:'upstream_http_error'});
 globalThis.fetch=async()=>Response.json({code:7,message:'not available'});await assert.rejects(jsonFetch('https://sample.invalid'),{status:502,code:'business_error'});
 globalThis.fetch=async()=>new Response('<html>busy</html>',{status:429});await assert.rejects(jsonFetch('https://sample.invalid'),{status:429,code:'invalid_upstream_response'});
 globalThis.fetch=async()=>Response.json({code:'ok'});assert.deepEqual(await jsonFetch('https://sample.invalid',{successCodes:['ok']}),{code:'ok'});
});
test('jsonFetch preserves method headers body redirect and caller signal',async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);const controller=new AbortController();let sent;
 globalThis.fetch=async(url,options)=>{sent={url,options};return Response.json({code:0});};
 await jsonFetch('https://sample.invalid',{body:{sample:true},headers:{'X-Sample':'test'},signal:controller.signal});
 assert.equal(sent.options.method,'POST');assert.equal(sent.options.body,'{"sample":true}');assert.equal(sent.options.headers['X-Sample'],'test');assert.equal(sent.options.headers['Content-Type'],'application/json');assert.equal(sent.options.redirect,'error');assert.equal(sent.options.signal,controller.signal);
});
test('redaction covers short-before-long overlapping secrets',()=>{
 rememberSecret('SAMPLE-prefix-A');rememberSecret('SAMPLE-prefix-A-secret-tail');
 assert.equal(redact('before SAMPLE-prefix-A-secret-tail after'),'before [REDACTED] after');
});
test('redaction covers long-before-short overlapping secrets',()=>{
 rememberSecret('SAMPLE-prefix-B-secret-tail');rememberSecret('SAMPLE-prefix-B');
 assert.equal(redact('SAMPLE-prefix-B-secret-tail'),'[REDACTED]');
});
test('redaction merges cross-position overlap and self-overlap',()=>{
 rememberSecret('abcDEFGH');rememberSecret('DEFGHijk');rememberSecret('zyzyzy');
 assert.equal(redact('left abcDEFGHijk right'),'left [REDACTED] right');assert.equal(redact('zyzyzyzyzy'),'[REDACTED]');
});
test('redaction preserves repeated, adjacent, unicode and literal metacharacters',()=>{
 const a='SAMPLE-one-!.*',b='SAMPLE-two-中文';rememberSecret(a);rememberSecret(b);
 assert.equal(redact(a+a+' '+b),'[REDACTED][REDACTED] [REDACTED]');assert.equal(redact({value:b}),' {"value":"[REDACTED]"}'.trim());
});
test('redaction preserves original Bearer JWT and ordinary message handling',()=>{
 assert.equal(redact('Bearer SAMPLE-unregistered-token'),'Bearer [REDACTED]');assert.equal(redact('eyJfake.payload.signature'),'[JWT]');assert.equal(redact('ordinary message'),'ordinary message');
 assert.equal(rememberSecret('tiny'),'tiny');assert.equal(redact('tiny'),'tiny');assert.equal(errorView(new AppError('Bearer SAMPLE-message',401,'auth_error')).message,'Bearer [REDACTED]');
});
