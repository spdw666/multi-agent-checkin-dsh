import {join} from 'node:path';
import {ConfigStore} from './config.mjs';
import {Ledger} from './store.mjs';
import {CredentialManager} from './credentials.mjs';
import {Platforms} from './platforms.mjs';
import {ClaimService} from './claims.mjs';
import {Router} from './router.mjs';
import {Scheduler} from './scheduler.mjs';
import {readJson,atomicJson,secret,rememberSecret} from './util.mjs';
export async function createService(file,{schedule=false}={}) {
  const config=new ConfigStore(file);await config.load();const ledger=new Ledger(config.dataDir);
  const credentials=new CredentialManager(config,ledger);const platforms=new Platforms(config,credentials);const claims=new ClaimService(config,credentials,platforms,ledger);const router=new Router(config,platforms,{ledger});const scheduler=new Scheduler(config,claims,ledger);
  const keysFile=join(config.dataDir,'api-keys.json');let keys;
  try{keys=await readJson(keysFile)}catch(e){if(e.code!=='ENOENT'){ledger.close();throw e;}keys={adminKey:secret(),apiKey:secret()};await atomicJson(keysFile,keys);}
  if(typeof keys.adminKey!=='string'||typeof keys.apiKey!=='string'||keys.adminKey.length<24||keys.apiKey.length<24)throw new Error('Gateway keys must be at least 24 characters');
  rememberSecret(keys.adminKey);rememberSecret(keys.apiKey);
  let closing;const service={config,ledger,credentials,platforms,claims,router,scheduler,keys,keysFile,close(){return closing??=(async()=>{await scheduler.stop();ledger.close();})();}};
  if(schedule)scheduler.start();return service;
}
