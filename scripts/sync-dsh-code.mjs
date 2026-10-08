import {readdir,readFile,mkdir,copyFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {projectRoot} from '../src/config.mjs';
import {hash} from '../src/util.mjs';
export async function syncDshCode(target){
 const changes=[];let verified=0;
 async function walk(folder){for(const entry of await readdir(join(projectRoot,folder),{withFileTypes:true})){const relative=join(folder,entry.name);if(entry.isDirectory()){await walk(relative);continue}if(!entry.isFile()||entry.name.includes('fixture'))continue;const source=join(projectRoot,relative),destination=join(target,relative);const expected=hash(await readFile(source));let actual;try{actual=hash(await readFile(destination))}catch(e){if(e.code!=='ENOENT')throw e}if(actual!==expected){await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);changes.push(relative)}if(hash(await readFile(destination))!==expected)throw new Error('DSH code hash mismatch: '+relative);verified++}}
 for(const folder of ['src','vendor','bundle'])await walk(folder);
 return {verified,changes};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await syncDshCode(process.argv[2]??join(homedir(),'.dsh/profiles/desktop/node_modules/dsh-ai-credit-gateway'))));
