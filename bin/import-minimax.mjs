#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {ConfigStore} from '../src/config.mjs';
import {importMiniMaxSession} from '../src/browser-session.mjs';
import {errorView} from '../src/util.mjs';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1]};
try {
 const config=new ConfigStore(resolve(option('config','./config.local.json')));await config.load();
 const id=option('account','minimax-main'),a=config.value.accounts.find(a=>a.id===id&&a.platform==='minimax');
 if(!a)throw new Error('MiniMax account not configured');
 const report=await importMiniMaxSession(join(config.dataDir,'accounts',id,'browser'),config.path(a.credentials.file),{region:a.region??'cn'});
 console.log(JSON.stringify(report));
}catch(e){console.log(JSON.stringify({error:errorView(e)}));process.exitCode=1;}
