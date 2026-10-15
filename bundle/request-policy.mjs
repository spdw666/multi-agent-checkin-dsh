// Product-level DSH request defaults; never rewrite caller messages or tools.
export function gatewayRequestPolicy(runtime={},models=[]){
  const max=runtime.maxOutputTokens;
  if(max!==undefined&&(!Number.isSafeInteger(max)||max<1))throw new TypeError('runtime.maxOutputTokens must be a positive safe integer');
  const configuredMaxTokens=new Map();let streamIdleTimeoutMs=180000;
  for(const m of models){
    if(max!==undefined&&Number.isSafeInteger(m.maxTokens)&&m.maxTokens>0)configuredMaxTokens.set(m.id,Math.min(max,m.maxTokens));
    const declared=m.requestTimeoutMs;
    const knownKimi=m.id==='moonshotai/kimi-k3'||/^nvidia[^/]*\/(?:moonshotai\/)?kimi-k3$/.test(m.id);
    const requested=Number.isSafeInteger(declared)&&declared>0?declared:knownKimi?600000:180000;
    streamIdleTimeoutMs=Math.max(streamIdleTimeoutMs,Math.min(requested,600000));
    // Verified relay buffering intentionally hides unsuccessful partial output.
    // Give the server's full bounded request deadline a small error-delivery
    // margin instead of mistaking that silent window for a human cancellation.
    const relay=m.modelRelay;
    if(relay?.deliveryMode==='verified_request_buffer'&&Number.isSafeInteger(relay.requestTimeoutMs)&&relay.requestTimeoutMs>0&&relay.requestTimeoutMs<=1200000)
      streamIdleTimeoutMs=Math.max(streamIdleTimeoutMs,Math.min(relay.requestTimeoutMs+10000,1210000));
  }
  return {configuredMaxTokens,streamIdleTimeoutMs};
}
