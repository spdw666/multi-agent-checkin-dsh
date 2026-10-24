// Offline, validation-preserving local-$ref expansion for modern JSON Schema.
// Does not fetch, delete tools, widen assertions, or truncate recursive schemas.
const mapKeys=new Set(['properties','patternProperties','$defs','definitions','dependentSchemas']);
const arrayKeys=new Set(['allOf','anyOf','oneOf','prefixItems']);
const singleKeys=new Set(['additionalProperties','unevaluatedProperties','propertyNames','contains','items','additionalItems','unevaluatedItems','not','if','then','else','contentSchema']);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const esc=x=>x.replaceAll('~','~0').replaceAll('/','~1');
const clone=x=>structuredClone(x);
function children(node,pointer,includeDefs=true){
 const out=[];if(!isObject(node))return out;
 for(const [key,value]of Object.entries(node)){
  if(mapKeys.has(key)&&isObject(value)){if(!includeDefs&&(key==='$defs'||key==='definitions'))continue;for(const [name,sub]of Object.entries(value))out.push([sub,pointer+'/'+esc(key)+'/'+esc(name)]);}
  else if(arrayKeys.has(key)&&Array.isArray(value))value.forEach((sub,i)=>out.push([sub,pointer+'/'+key+'/'+i]));
  else if(singleKeys.has(key)){if(Array.isArray(value))value.forEach((sub,i)=>out.push([sub,pointer+'/'+key+'/'+i]));else if(typeof value==='boolean'||isObject(value))out.push([value,pointer+'/'+key]);}
  else if(key==='dependencies'&&isObject(value)){for(const [name,sub]of Object.entries(value))if(!Array.isArray(sub))out.push([sub,pointer+'/dependencies/'+esc(name)]);}
 }
 return out;
}
function pointerOf(ref){
 if(typeof ref!=='string'||!ref.startsWith('#'))throw Error('Only in-document JSON Pointer references are expanded');
 const decoded=decodeURIComponent(ref.slice(1));if(decoded==='')return '#';
 if(!decoded.startsWith('/')||/~(?:[^01]|$)/.test(decoded))throw Error('Reference is not a JSON Pointer');
 return '#'+decoded.split('/').slice(1).map(x=>esc(x.replaceAll('~1','/').replaceAll('~0','~'))).map(x=>'/'+x).join('');
}
export function analyzeLocalRefs(schema){
 const nodes=new Map(),refs=[],unsupported=[];
 function collect(node,pointer){nodes.set(pointer,node);if(!isObject(node))return;
  if(pointer!=='#'&&('$id'in node||'$anchor'in node))unsupported.push({path:pointer,reason:'nested-resource-or-anchor'});
  if('$dynamicRef'in node||'$recursiveRef'in node||'$dynamicAnchor'in node||'$recursiveAnchor'in node)unsupported.push({path:pointer,reason:'dynamic-reference-scope'});
  if('$ref'in node){try{refs.push({path:pointer,ref:node.$ref,target:pointerOf(node.$ref)})}catch(e){unsupported.push({path:pointer,ref:node.$ref,reason:e.message})}}
  for(const [sub,p]of children(node,pointer))collect(sub,p);
 }
 collect(schema,'#');for(const row of refs)if(!nodes.has(row.target))unsupported.push({...row,reason:'reference-target-is-not-a-known-schema-location'});
 const starts=new Set(['#',...refs.map(x=>x.target)]),graph=new Map();
 for(const start of starts){const edges=[];function scan(n,p){if(!isObject(n))return;if('$ref'in n){try{edges.push({from:start,path:p,ref:n.$ref,to:pointerOf(n.$ref)})}catch{}}for(const [sub,q]of children(n,p,false))scan(sub,q);}scan(nodes.get(start),start);graph.set(start,edges);}
 const colors=new Map(),stack=[],cycles=[];
 function visit(v){colors.set(v,1);stack.push(v);for(const edge of graph.get(v)??[]){if(colors.get(edge.to)===1){const i=stack.indexOf(edge.to);cycles.push({vertices:[...stack.slice(i),edge.to],edge});}else if(!colors.has(edge.to))visit(edge.to);}stack.pop();colors.set(v,2);}
 visit('#');const reachable=new Set(colors.keys());for(const v of starts)if(!colors.has(v))visit(v);
 return {references:refs,cycles:cycles.map(c=>({...c,reachable:reachable.has(c.vertices[0])})),unsupported,schemaNodes:nodes.size,sharedTargets: [...new Set(refs.map(x=>x.target))].map(target=>({target,references:refs.filter(x=>x.target===target).length})).filter(x=>x.references>1),_nodes:nodes};
}
export function normalizeLocalRefs(schema,{assumeModernDialect=false,maxExpandedNodes=1000000}={}){
 const before=analyzeLocalRefs(schema),report={schemaNodes:before.schemaNodes,references:before.references.length,cycles:before.cycles,sharedTargets:before.sharedTargets,unsupported:before.unsupported,expandedReferences:0,expandedNodes:0};
 const dialect=isObject(schema)?schema.$schema:undefined;
 if(dialect!==undefined&&!/^https?:\/\/json-schema\.org\/draft\/(?:2020-12|2019-09)\/(?:schema|hyper-schema)#?$/.test(dialect))report.unsupported.push({path:'#',reason:'unsupported-dialect',dialect});
 if(dialect===undefined&&!assumeModernDialect&&before.references.length)report.unsupported.push({path:'#',reason:'modern-ref-sibling-semantics-not-declared'});
 if(report.unsupported.length||report.cycles.some(c=>c.reachable))return {schema:clone(schema),changed:false,status:report.unsupported.length?'unsupported-preserved':'recursive-preserved',report};
 function rewrite(node,pointer,active){
  if(++report.expandedNodes>maxExpandedNodes)throw Error('Expansion resource budget exceeded; no partial result emitted');
  if(!isObject(node))return clone(node);
  const entries=[];for(const [key,value]of Object.entries(node)){
   if(key==='$ref'||key==='$defs'||key==='definitions')continue;
   let next=clone(value);
   if(mapKeys.has(key)&&isObject(value))next=Object.fromEntries(Object.entries(value).map(([name,sub])=>[name,rewrite(sub,pointer+'/'+key+'/'+esc(name),active)]));
   else if(arrayKeys.has(key)&&Array.isArray(value))next=value.map((sub,i)=>rewrite(sub,pointer+'/'+key+'/'+i,active));
   else if(singleKeys.has(key)){if(Array.isArray(value))next=value.map((sub,i)=>rewrite(sub,pointer+'/'+key+'/'+i,active));else if(typeof value==='boolean'||isObject(value))next=rewrite(value,pointer+'/'+key,active);}
   else if(key==='dependencies'&&isObject(value))next=Object.fromEntries(Object.entries(value).map(([name,sub])=>[name,Array.isArray(sub)?clone(sub):rewrite(sub,pointer+'/dependencies/'+esc(name),active)]));
   entries.push([key,next]);
  }
  const siblings=Object.fromEntries(entries);if(!('$ref'in node))return siblings;
  const target=pointerOf(node.$ref);if(active.has(target))throw Error('Cycle detected during expansion; no partial result emitted');
  const nextActive=new Set(active);nextActive.add(target);report.expandedReferences++;
  const expanded=rewrite(before._nodes.get(target),target,nextActive);
  if(entries.length===0)return expanded;
  // Never merge properties/required/additionalProperties across a reference.
  // Modern $ref is an applicator with active siblings: a one-element allOf
  // preserves that conjunction and its evaluated-properties annotations.
  return {...siblings,allOf:[expanded,...(Array.isArray(siblings.allOf)?siblings.allOf:[])]};
 }
 try{const result=rewrite(schema,'#',new Set(['#']));const after=analyzeLocalRefs(result);if(after.references.length)throw Error('Remaining reference after acyclic expansion');report.remainingReferences=0;return {schema:result,changed:JSON.stringify(result)!==JSON.stringify(schema),status:'expanded',report};}
 catch(error){return {schema:clone(schema),changed:false,status:'resource-or-cycle-preserved',report:{...report,error:error.message}};}
}
