// Independently implemented. Single-flight and lifecycle patterns reviewed in
// dingminhua/dsh-connect-trae (MIT), auth.ts and index.ts, commit 16817ef7.
export function createModelRefresh({load,update,onError=()=>{},initialModels=[]}) {
  let stopped=false,flight,controller;
  let fingerprint=JSON.stringify(initialModels);
  const refresh=()=>{
    if(stopped)return Promise.resolve(false);
    if(flight)return flight;
    controller=new AbortController();
    const signal=controller.signal;
    flight=Promise.resolve().then(()=>load(signal)).then(models=>{
      if(stopped||signal.aborted)return false;
      if(!Array.isArray(models))throw new TypeError('Gateway models must be an array');
      const next=JSON.stringify(models);
      if(next===fingerprint)return false;
      update(models);fingerprint=next;return true;
    }).catch(error=>{if(!stopped&&!signal.aborted)onError(error);return false;})
      .finally(()=>{flight=undefined;controller=undefined;});
    return flight;
  };
  return {refresh,close(){stopped=true;controller?.abort();}};
}
