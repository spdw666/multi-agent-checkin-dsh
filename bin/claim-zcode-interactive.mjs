#!/usr/bin/env node
import {resolve} from 'node:path';
import {createService} from '../src/service.mjs';
import {zcodeClaim} from '../src/zcode.mjs';
import {zcodeValidation} from '../src/browser-session.mjs';
import {errorView} from '../src/util.mjs';
const args=process.argv.slice(2),i=args.indexOf('--config'),file=resolve(i<0?'./config.local.json':args[i+1]);
let s;
try {
 s=await createService(file);const account=s.config.value.accounts.find(a=>a.id==='zcode-main');account.enabled=true;account.tasks=[{id:'free-plan-claim',enabled:true}];
 const original=s.platforms.claim.bind(s.platforms);
 s.platforms.claim=async (id,task)=>id==='zcode-main'&&task==='free-plan-claim'?zcodeClaim(await s.credentials.resolve(id),{ledger:s.ledger,profileDir:s.config.path('./data/accounts/zcode-main/captcha-browser'),validate:(profile,region)=>zcodeValidation(profile,region,{headless:false,timeout:300000})}):original(id,task);
 console.log(JSON.stringify(await s.claims.run('zcode-main','free-plan-claim')));
}catch(e){console.log(JSON.stringify({error:errorView(e)}));process.exitCode=1;}finally{if(s)await s.close()}
