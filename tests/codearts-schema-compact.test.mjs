import assert from 'node:assert/strict';
import test from 'node:test';
import {compactExpandedSchema} from '../src/codearts-schema-compact.mjs';
const copy=x=>structuredClone(x);
const shared={type:'object',description:'Full common nested constraints retained.',properties:{x:{type:'integer',minimum:3},label:{type:'string',minLength:2,maxLength:30}},required:['x','label'],additionalProperties:false};
const fixture=()=>({type:'object',properties:{before:copy(shared),after:copy(shared),other:{type:'string'}},additionalProperties:false});
let checks=0;
test('own schema __proto__/constructor/prototype keys survive split, walk and factoring',()=>{
 const input=fixture();
 for(const key of ['__proto__','constructor','prototype']){
  Object.defineProperty(input,key,{value:{preserved:'root-'+key},enumerable:true,writable:true,configurable:true});
  for(const name of ['before','after'])Object.defineProperty(input.properties[name],key,{value:{preserved:'constraint-'+key},enumerable:true,writable:true,configurable:true});
  Object.defineProperty(input.properties,key,{value:{type:'string',description:'Data property '+key},enumerable:true,writable:true,configurable:true});
 }
 const before=JSON.stringify(input),result=compactExpandedSchema(input),out=result.schema;
 assert.ok(result.report.siblingGroups.length>0);assert.equal(JSON.stringify(input),before);
 for(const key of ['__proto__','constructor','prototype']){
  assert.ok(Object.hasOwn(out,key));assert.deepEqual(out[key],{preserved:'root-'+key});
  assert.ok(Object.hasOwn(out.properties,key));assert.deepEqual(out.properties[key],input.properties[key]);
  const moved=out.allOf.find(x=>x.additionalProperties?.properties?.x)?.additionalProperties;
  assert.ok(moved&&Object.hasOwn(moved,key));assert.deepEqual(moved[key],{preserved:'constraint-'+key});checks++;
 }
 assert.equal(Object.getPrototypeOf(out),Object.prototype);assert.equal(Object.getPrototypeOf(out.properties),Object.prototype);assert.equal(Object.prototype.preserved,undefined);
});
test('schema keys named __proto__ remain data even inside anyOf common-field split',()=>{
 const schema={type:'object',anyOf:[{properties:{same:copy(shared),kind:{const:'a'}},required:['kind'],additionalProperties:false},{properties:{same:copy(shared),kind:{const:'b'}},required:['kind'],additionalProperties:false}]};
 for(const branch of schema.anyOf)Object.defineProperty(branch.properties.same,'__proto__',{value:{keep:'own extension'},writable:true,enumerable:true,configurable:true});
 const result=compactExpandedSchema(schema);assert.ok(result.report.alternativeGroups.length);
 const moved=result.schema.allOf[0].properties.same;assert.ok(Object.hasOwn(moved,'__proto__'));assert.deepEqual(moved.__proto__,{keep:'own extension'});checks++;
});
test('every unverified resource, dynamic, evaluation, tuple and legacy dependency scope preserves whole input',()=>{
 const cases=[
  {$id:'urn:scoped:nested'},{$anchor:'point'},{$dynamicAnchor:'dynamic'},{$recursiveAnchor:true},{$dynamicRef:'#dynamic'},{$recursiveRef:'#'},{$ref:'#/$defs/X'},
  {unevaluatedProperties:false},{unevaluatedItems:false},{items:[{type:'integer'},{type:'string'}]},
  {prefixItems:[{type:'integer'}]},{additionalItems:false},{dependencies:{x:['y']}},{dependencies:{x:{required:['y']}}},
  {$schema:'https://json-schema.org/draft/2020-12/schema'},{$vocabulary:{'urn:extra':true}}
 ];
 const embeddings=[s=>({properties:{protected:s}}),s=>({allOf:[s]}),s=>({definitions:{protected:s}}),s=>({dependentSchemas:{x:s}}),s=>({not:s}),s=>({patternProperties:{'^x':s}}),s=>({if:s,then:{type:'string'},else:{type:'number'}})];
 for(const scope of cases)for(const embed of embeddings){const input={...fixture(),...embed({...copy(shared),...copy(scope)})},before=JSON.stringify(input),r=compactExpandedSchema(input);assert.deepEqual(r.schema,input);assert.equal(JSON.stringify(r.schema),before);assert.equal(JSON.stringify(input),before);assert.ok(r.report.unchangedReason);assert.equal(r.report.savedBytes,0);assert.equal(r.report.siblingGroups.length,0);assert.equal(r.report.alternativeGroups.length,0);checks++;}
 for(const root of [{$anchor:'root'},{$dynamicAnchor:'root'},{$schema:'http://json-schema.org/draft-07/schema#'},{$schema:false}]){const input={...fixture(),...root},r=compactExpandedSchema(input);assert.deepEqual(r.schema,input);assert.ok(r.report.unchangedReason);checks++;}
});
test('root id and supported dialect retain own data; data annotations do not create fake schema scopes',()=>{
 const schema={...fixture(),$id:'urn:root',$schema:'https://json-schema.org/draft/2020-12/schema',examples:[{$id:'data',dependencies:{x:['y']},items:[{$anchor:'data'}]}],default:{$ref:'literal-data'},description:'descriptive text'};
 const r=compactExpandedSchema(schema);assert.equal(r.report.unchangedReason,null);assert.ok(r.report.siblingGroups.length>0);assert.equal(r.schema.$id,schema.$id);assert.deepEqual(r.schema.examples,schema.examples);assert.deepEqual(r.schema.default,schema.default);checks++;
});

test('closed groups keep every assertion in an obligatory additionalProperties conjunct',()=>{const input=fixture(),r=compactExpandedSchema(input);assert.ok(r.report.savedBytes>0);assert.equal(r.schema.additionalProperties,false);assert.deepEqual(Object.keys(r.schema.properties),['before','after','other']);assert.equal(r.schema.properties.other.type,'string');const group=r.schema.allOf.find(x=>x.additionalProperties?.required);assert.deepEqual(group.additionalProperties.required,['x','label']);assert.equal(group.additionalProperties.additionalProperties,false);assert.deepEqual(JSON.parse(JSON.stringify(group.properties)),{other:{}});assert.deepEqual(group.additionalProperties.properties,shared.properties);});
