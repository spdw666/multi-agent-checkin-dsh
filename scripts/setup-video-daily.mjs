import {ConfigStore} from '../src/config.mjs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AppError} from '../src/util.mjs';
export async function setupVideoDaily(configFile,{apply=false}={}){
 const config=new ConfigStore(resolve(configFile));await config.load();const before=await config.snapshot(),next=structuredClone(before.value),added=[];
 for(const [platform,label]of [['vidu','Vidu 视频每日积分'],['pixverse','PixVerse 视频每日积分'],['jimeng','即梦 视频每日积分'],['kling','可灵 视频每日积分'],['xiaoyunque','小云雀 视频每日积分'],['hailuo','海螺 视频每日积分'],['liblib','Liblib 视频每日积分']]){
  const id=platform+'-video-daily',present=next.accounts.find(a=>a.id===id);
  if(present){if(present.platform!==platform)throw new AppError('Video account ID is already used by another platform',409,'video_daily_account_conflict');continue;}
  const file=['vidu','pixverse'].includes(platform)?join(config.dataDir,'accounts',id,'credential.json'):join(config.dataDir,'video-sessions',platform+'.verified.json');
  next.accounts.push({id,label,platform,enabled:true,inferenceEnabled:false,credentials:{kind:'file',file},tasks:[{id:'daily-checkin',enabled:true}]});added.push(id);
 }
 if(apply&&added.length)await config.save(next,{expectedSha256:before.sha256});
 return {mode:apply?'applied':'preview',added,accountsBefore:before.value.accounts.length,accountsAfter:next.accounts.length,upstreamsUnchanged:JSON.stringify(next.upstreams)===JSON.stringify(before.value.upstreams),routesUnchanged:JSON.stringify(next.routes)===JSON.stringify(before.value.routes),schedulerUnchanged:JSON.stringify(next.scheduler)===JSON.stringify(before.value.scheduler),credentialsWritten:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),i=args.indexOf('--config');
 if(i<0||!args[i+1]){console.error('Usage: node scripts/setup-video-daily.mjs --config CONFIG_FILE [--apply]');process.exitCode=2;}
 else try{console.log(JSON.stringify(await setupVideoDaily(args[i+1],{apply:args.includes('--apply')})));}catch(e){console.error(JSON.stringify({error:e.code??'setup_failed',message:e.message}));process.exitCode=1;}
}
