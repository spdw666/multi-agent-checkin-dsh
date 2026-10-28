import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../desktop/webview-shell/ui/management.js',import.meta.url),'utf8');
const handler=source.match(/  (function handleClick\(event\)\{[^\n]+\})\r?\n  function handleKey/)[1];
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
