export function thinkingMetadata(model){
  const map=Object.fromEntries(['off','minimal','low','medium','high','xhigh','max'].map(k=>[k,null]));
  for(const [key,value] of Object.entries(model.reasoningEfforts??{}))if(key in map&&typeof value==='string'&&value)map[key]=value;
  const supported=Object.values(map).some(v=>v!==null);
  return {reasoning:!!model.reasoning||supported,compat:{supportsReasoningEffort:supported},thinkingLevelMap:map};
}
