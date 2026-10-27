export function withTimeout(action,ms,code,signal){
  return new Promise((resolve,reject)=>{
    let finished=false,timer;
    const finish=(fn,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);fn(value);};
    const aborted=()=>finish(reject,new Error('import_total_timeout'));
    if(signal?.aborted){aborted();return;}
    signal?.addEventListener('abort',aborted,{once:true});timer=setTimeout(()=>finish(reject,new Error(code)),ms);
    Promise.resolve().then(()=>{if(signal?.aborted)throw new Error('import_total_timeout');return action();}).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}
