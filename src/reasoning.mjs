export function thinkingMetadata(model){
  const map=Object.fromEntries(['off','minimal','low','medium','high','xhigh','max'].map(k=>[k,null]));
  for(const [key,value] of Object.entries(model.reasoningEfforts??{}))if(key in map&&typeof value==='string'&&value)map[key]=value;
  const supported=Object.values(map).some(v=>v!==null);
  // DSH requires at least one selectable effort when its Pi adapter says reasoning=true.
  // An upstream can think internally without exposing an adjustable effort parameter.
  // Keep that fact in the catalog, but do not manufacture a selectable DSH level.
  return {reasoning:supported,compat:{supportsReasoningEffort:supported},thinkingLevelMap:map};
}
