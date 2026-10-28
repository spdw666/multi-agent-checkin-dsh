import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../desktop/webview-shell/ui/management.js',import.meta.url),'utf8');
const handler=source.match(/  (function handleClick\(event\)\{[^\n]+\})\r?\n  function handleKey/)[1];
const actual=name=>source.split(/\r?\n/).find(line=>new RegExp('^  (?:async )?function '+name+'\\(').test(line)).trim();
const obj=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
function clickImport(indexes,payload={format:'json',content:'SAMPLE_IMPORT'}){
  const opened=[],toasts=[],nodes=indexes.map(index=>({dataset:{importIndex:String(index)}}));
  const button={dataset:{},hasAttribute:name=>name==='data-m-import-commit'};
  const document={querySelector:()=>nodes[0]??null,querySelectorAll:()=>nodes};
  const context={
    event:{target:{closest:()=>button}},importPayload:payload,
    $:selector=>document.querySelector(selector),$$:selector=>[...document.querySelectorAll(selector)],
    ctx:{toast:message=>toasts.push(message)},openAction:(...args)=>opened.push(args)
  };
  runInNewContext('('+handler+')(event)',context);
  return JSON.parse(JSON.stringify({opened,toasts}));
}

test('actual WB import handler collects every selected checkbox into confirmation',()=>{
  const result=clickImport([0,3]);assert.equal(result.opened.length,1);
  assert.deepEqual(result.opened[0],['wb.importCommit','',{format:'json',duplicatePolicy:'skip',selectedIndexes:[0,3]},{content:'SAMPLE_IMPORT'}]);
  assert.deepEqual(result.toasts,[]);
});
test('actual WB import handler with zero selections never opens mutation confirmation',()=>{
  const result=clickImport([]);assert.deepEqual(result.opened,[]);assert.equal(result.toasts.length,1);
});
test('actual WB import handler without retained preview never submits selected DOM data',()=>{
  const result=clickImport([1],null);assert.deepEqual(result.opened,[]);assert.equal(result.toasts.length,1);
});

test('actual import panel renders the real flat preview DTO rather than its boolean marker',()=>{
  const context={importPayload:{content:'SAMPLE_IMPORT'},state:{busy:false,result:{operation:{kind:'wb.importPreview'}},extra:{preview:true,valid:true,count:1,entries:[{index:2,valid:true,label:'SAMPLE_ACCOUNT'}]}},obj,arr:value=>Array.isArray(value)?value:[],esc:value=>String(value??''),badge:()=>''};
  const html=runInNewContext('('+actual('importPanel')+')()',context);
  assert.match(html,/SAMPLE_ACCOUNT/);assert.match(html,/data-import-index="2"/);
});

function closeDialog(action){
  const events={},payload={content:'SAMPLE_IMPORT'};
  const dialog={setAttribute(){},addEventListener(name,fn){events[name]=fn;}};
  const context={state:{dialog:{action},result:{operation:{kind:action,status:'completed'}}},importPayload:payload,ctx:null,options:{icon:()=>''},document:{createElement:()=>dialog,body:{append(){}},addEventListener(){}},$:()=>({addEventListener(){},innerHTML:''}),submitAction(){},handleClick(){},repaintSearch(){},handleKey(){}};
  runInNewContext('('+actual('init')+')(options)',context);events.close();return context;
}
test('closing a completed preview confirmation preserves the preview payload',()=>{
  const context=closeDialog('wb.importPreview');assert.equal(context.importPayload?.content,'SAMPLE_IMPORT');assert.equal(context.state.dialog,null);
});
test('cancelling commit confirmation preserves the preview for review without mutation',()=>{
  const context=closeDialog('wb.importCommit');assert.equal(context.importPayload?.content,'SAMPLE_IMPORT');assert.equal(context.state.dialog,null);
});
test('explicit discard clears retained import payload and preview',()=>{
  const button={dataset:{},hasAttribute:name=>name==='data-m-import-discard'};
  const context={event:{target:{closest:()=>button}},importPayload:{content:'SAMPLE_IMPORT'},state:{extra:{entries:[]}},ctx:{paint(){}}};
  runInNewContext('('+handler+')(event)',context);assert.equal(context.importPayload,null);assert.equal(context.state.extra,null);
});
async function completeCommit(status){
  const calls=[];
  const context={state:{busy:false,error:''},importPayload:{content:'SAMPLE_IMPORT'},request:{action:'wb.importCommit'},obj,ctx:{busy:()=>false,paint(){},bridge:async(method,request)=>{calls.push({method,request});return {operation:{kind:'wb.importCommit',status}};}},read:async()=>{}};
  await runInNewContext('('+actual('act')+')(request)',context);return {context,calls};
}
test('completed import clears retained input even when the backend response has no data',async()=>{
  const {context,calls}=await completeCommit('completed');assert.equal(context.importPayload,null);assert.equal(calls.length,1);
});
test('uncertain import retains preview for review and never automatically replays mutation',async()=>{
  const {context,calls}=await completeCommit('uncertain');assert.equal(context.importPayload?.content,'SAMPLE_IMPORT');assert.equal(calls.length,1);
});
