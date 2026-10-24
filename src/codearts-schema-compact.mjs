// Assertion-preserving, reference-free JSON Schema factoring.
// Scope-sensitive/unsupported inputs are preserved in full, never partially
// rewritten. This module does not itself establish provider acceptance.
const annotations = new Set(['description','title','default','examples','$comment','deprecated','readOnly','writeOnly']);
const maps = new Set(['properties','patternProperties','$defs','definitions','dependentSchemas']);
const arrays = new Set(['allOf','anyOf','oneOf','prefixItems']);
const singles = new Set(['additionalProperties','unevaluatedProperties','propertyNames','contains','items','additionalItems','unevaluatedItems','not','if','then','else','contentSchema']);
const clone = x => structuredClone(x);
const text = x => JSON.stringify(x);
const bytes = x => Buffer.byteLength(text(x));
const object = x => x && typeof x === 'object' && !Array.isArray(x);
function split(node) {
  if (!object(node)) return {notes:{}, constraint:node};
  const entries=Object.entries(node);
  // fromEntries creates own data keys, including __proto__/constructor. Direct
  // obj[key]=value on {} would invoke Object.prototype.__proto__'s setter.
  return {notes:Object.fromEntries(entries.filter(([k])=>annotations.has(k))),constraint:Object.fromEntries(entries.filter(([k])=>!annotations.has(k)))};
}
function placeholder(notes, schema) {
  // This declaration keeps the original allowed property name and its notes.
  // It is not the sole constraint: its full schema is the mandatory conjunct.
  return {...notes};
}
function appendAllOf(node, conjunct) { node.allOf=[...(node.allOf??[]),conjunct]; }
export function compactExpandedSchema(input, {siblings=true, alternatives=true}={}) {
  const report={inputChars:text(input).length,inputBytes:bytes(input),siblingGroups:[],alternativeGroups:[],singletonAllOf:0,unchangedReason:null};
  // This implementation only rewrites the tested modern, non-resource-scoped,
  // non-tuple, reference-free domain. A single unsupported schema scope blocks
  // the entire input, including its ancestors, so factoring cannot move or
  // duplicate a protected resource/anchor or alter evaluated-item semantics.
  const forbidden=[];
  const scopeKeys=['$ref','$anchor','$dynamicRef','$recursiveRef','$dynamicAnchor','$recursiveAnchor','$vocabulary','unevaluatedProperties','unevaluatedItems','prefixItems','additionalItems','dependencies'];
  const modern=/^https?:\/\/json-schema\.org\/draft\/(?:2020-12|2019-09)\/(?:schema|hyper-schema)#?$/;
  const scan=(n,path='#')=>{
    if(!object(n))return;
    for(const key of scopeKeys)if(Object.hasOwn(n,key))forbidden.push({path,reason:key});
    if(path!=='#'&&Object.hasOwn(n,'$id'))forbidden.push({path,reason:'nested-$id'});
    if(Object.hasOwn(n,'$schema')&&(path!=='#'||typeof n.$schema!=='string'||!modern.test(n.$schema)))forbidden.push({path,reason:'unsupported-or-nested-$schema'});
    if(Array.isArray(n.items))forbidden.push({path,reason:'tuple-items'});
    for(const[k,v]of Object.entries(n)){
      if(maps.has(k)&&object(v))for(const[name,x]of Object.entries(v))scan(x,path+'/'+k+'/'+name);
      else if(arrays.has(k)&&Array.isArray(v))v.forEach((x,i)=>scan(x,path+'/'+k+'/'+i));
      else if(singles.has(k)&&!Array.isArray(v))scan(v,path+'/'+k);
    }
  };
  scan(input);
  if(forbidden.length){report.unchangedReason='unsupported schema scope/vocabulary: '+[...new Set(forbidden.map(x=>x.reason))].join(',');report.preservedScopes=forbidden;report.outputChars=report.inputChars;report.outputBytes=report.inputBytes;report.savedBytes=0;return {schema:clone(input),report};}
  function walk(source,path='#') {
    if(!object(source))return clone(source);
    const entries=[];
    for(const[k,v]of Object.entries(source)){
      let next;
      if(maps.has(k)&&object(v))next=Object.fromEntries(Object.entries(v).map(([n,s])=>[n,walk(s,path+'/'+k+'/'+n)]));
      else if(arrays.has(k)&&Array.isArray(v))next=v.map((s,i)=>walk(s,path+'/'+k+'/'+i));
      else if(singles.has(k)&&!Array.isArray(v))next=walk(v,path+'/'+k);
      else next=clone(v);
      entries.push([k,next]);
    }
    let node=Object.fromEntries(entries);
    if(Array.isArray(node.allOf)&&node.allOf.length===1){
      const outer=Object.entries(node).filter(([k])=>k!=='allOf'),target=node.allOf[0];
      if(outer.length===0){report.singletonAllOf++;node=target;}
      else if(object(target)&&outer.every(([k,v])=>annotations.has(k)&&(!Object.hasOwn(target,k)||text(target[k])===text(v)))){
        // No assertions or conflicting annotations cross this allOf boundary.
        report.singletonAllOf++;node={...target,...Object.fromEntries(outer)};
      }
    }
    if(!object(node))return node;
    if(alternatives)for(const key of ['anyOf','oneOf']){
      const branches=node[key];
      if(!Array.isArray(branches)||branches.length<2||!branches.every(b=>object(b)&&object(b.properties)))continue;
      const common=Object.create(null);
      for(const[name,first]of Object.entries(branches[0].properties)){
        const firstSplit=split(first),signature=text(firstSplit.constraint);
        if(signature==='{}'||signature==='true')continue;
        if(!branches.every(b=>Object.hasOwn(b.properties,name)&&text(split(b.properties[name]).constraint)===signature))continue;
        const oldSize=bytes(node),trial=clone(node),shared=clone(firstSplit.constraint);
        trial[key].forEach(b=>{b.properties[name]=placeholder(split(b.properties[name]).notes,shared);});
        appendAllOf(trial,{properties:{[name]:shared}});
        if(bytes(trial)>=oldSize)continue;
        node=trial; common[name]=shared;
        report.alternativeGroups.push({path,key,name,branches:branches.length,savedBytes:oldSize-bytes(trial)});
      }
      // Re-consolidate adjacent freshly hoisted properties into one conjunct.
      if(Object.keys(common).length>1){const count=Object.keys(common).length;node.allOf.splice(-count,count,{properties:common});}
    }
    if(siblings&&object(node.properties)&&node.additionalProperties===false&&!Object.hasOwn(node,'patternProperties')){
      const groups=new Map();
      for(const[name,value]of Object.entries(node.properties)){
        let {notes,constraint}=split(value);
        if(object(constraint)&&Object.keys(constraint).length===1&&Array.isArray(constraint.allOf)&&constraint.allOf.length===1)constraint=constraint.allOf[0];
        const signature=text(constraint);
        if(signature==='{}'||signature==='true')continue;
        const entry=groups.get(signature)??{schema:constraint,rows:[]};entry.rows.push({name,notes});groups.set(signature,entry);
      }
      for(const group of groups.values()){
        if(group.rows.length<2)continue;
        const trial=clone(node),names=new Set(group.rows.map(x=>x.name)),excluded=Object.create(null);
        for(const name of Object.keys(node.properties))if(!names.has(name))excluded[name]={};
        for(const{name,notes}of group.rows)trial.properties[name]=placeholder(notes,group.schema);
        // Root AP=false still closes the exact original property set. This
        // conjunct excludes every other declared name, so its AP=S applies
        // precisely to the group, not to other allowed or newly admitted keys.
        appendAllOf(trial,{properties:excluded,additionalProperties:clone(group.schema)});
        const saved=bytes(node)-bytes(trial);
        if(saved>0){node=trial;report.siblingGroups.push({path,names:[...names],savedBytes:saved});}
      }
    }
    return node;
  }
  const schema=walk(input);report.outputChars=text(schema).length;report.outputBytes=bytes(schema);report.savedBytes=report.inputBytes-report.outputBytes;
  return {schema,report};
}
