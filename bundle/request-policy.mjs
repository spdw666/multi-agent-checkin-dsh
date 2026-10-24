// Product-level DSH request defaults; never rewrite caller messages or tools.
export function gatewayRequestPolicy(runtime={},models=[]){
  const max=runtime.maxOutputTokens;
  if(max!==undefined&&(!Number.isSafeInteger(max)||max<1))throw new TypeError('runtime.maxOutputTokens must be a positive safe integer');
  const configuredMaxTokens=new Map();let streamIdleTimeoutMs=180000;
  for(const m of models){
    // piProvider profiles do not infer ModelInfo.defaultMaxTokens from model.maxTokens.
    // Publish only a provider-declared default (currently verified native ZCode),
    // so companion middleware does not replace it with a generic registry cap.
    // This never clamps an explicit per-request GenerateOptions.maxTokens.
    const declaredDefault=Number.isSafeInteger(m.defaultMaxTokens)&&m.defaultMaxTokens>0?m.defaultMaxTokens:undefined;
    const requestedDefault=max??declaredDefault;
    if(requestedDefault!==undefined&&Number.isSafeInteger(m.maxTokens)&&m.maxTokens>0)configuredMaxTokens.set(m.id,Math.min(requestedDefault,m.maxTokens));
    const declared=m.requestTimeoutMs;
    const knownKimi=m.id==='moonshotai/kimi-k3'||/^nvidia[^/]*\/(?:moonshotai\/)?kimi-k3$/.test(m.id);
    const requested=Number.isSafeInteger(declared)&&declared>0?declared:knownKimi?600000:180000;
    if(Number.isSafeInteger(declared)&&declared>0||knownKimi)streamIdleTimeoutMs=Math.max(streamIdleTimeoutMs,Math.min(requested,1200000)+10000);
    // Verified relay buffering intentionally hides unsuccessful partial output.
    // Give the server's full bounded request deadline a small error-delivery
    // margin instead of mistaking that silent window for a human cancellation.
    const relay=m.modelRelay;
    if(relay?.deliveryMode==='verified_request_buffer'&&Number.isSafeInteger(relay.requestTimeoutMs)&&relay.requestTimeoutMs>0&&relay.requestTimeoutMs<=1200000)
      streamIdleTimeoutMs=Math.max(streamIdleTimeoutMs,Math.min(relay.requestTimeoutMs+10000,1210000));
  }
  return {configuredMaxTokens,streamIdleTimeoutMs};
}

// Carry provider-declared model information on the first packet as well as in
// ModelInfo; companion metadata discovery is asynchronous. Explicit request
// budgets/messages/tools are never rewritten here.
export function gatewayModelHeaders(model={},policy={}){
  if(typeof model.id!=='string'||! /^[\x21-\x7e]{1,256}$/.test(model.id))return {};
  const headers={},budget=policy.configuredMaxTokens?.get(model.id);
  if(Number.isSafeInteger(model.contextWindow)&&model.contextWindow>0){headers['x-bili-plugin-model']=model.id;headers['x-bili-plugin-context-window']=String(model.contextWindow);}
  if(Number.isSafeInteger(budget)&&budget>0){headers['x-bili-plugin-model']=model.id;headers['x-bili-plugin-max-output']=String(budget);}
  return headers;
}
