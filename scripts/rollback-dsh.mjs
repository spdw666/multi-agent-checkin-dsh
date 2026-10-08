import {join,resolve} from 'node:path';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {ConfigStore,projectRoot} from '../src/config.mjs';
import {hash,readJson} from '../src/util.mjs';
const args=process.argv.slice(2),i=args.indexOf('--config');const configFile=resolve(i<0?join(projectRoot,'config.local.json'):args[i+1]);const c=new ConfigStore(configFile);await c.load();const backup=join(c.dataDir,'dsh-install');const record=await readJson(join(backup,'record.json'));
for(const [name,expected]of Object.entries(record.after??{})){const current=hash(await readFile(join(record.profile,name)));if(current!==expected)throw new Error(`Profile ${name} changed after installation; preserve later changes before using byte-for-byte rollback`);}
for(const [name,entry]of Object.entries(record.before)){const target=join(record.profile,name);if(entry.exists){const bytes=await readFile(join(backup,name+'.original'));if(hash(bytes)!==entry.sha256)throw new Error('Backup hash mismatch: '+name);await writeFile(target,bytes);if(hash(await readFile(target))!==entry.sha256)throw new Error('Restore hash mismatch: '+name);}else await rm(target,{force:true});}
console.log('DSH_PROFILE_RESTORED exact original package.json / cordis.patch.yml / pnpm-lock.yaml; installed package cache retained but inactive');
