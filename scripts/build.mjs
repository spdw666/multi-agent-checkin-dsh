import {build} from 'esbuild';
await build({entryPoints:['vendor/workbuddy/entry.ts'],outfile:'vendor/workbuddy-core.mjs',bundle:true,platform:'node',format:'esm',target:'node22.23.3',legalComments:'inline'});
await build({entryPoints:['vendor/trae/entry.ts'],outfile:'vendor/trae-core.mjs',bundle:true,platform:'node',format:'esm',target:'node22.23.3',legalComments:'inline'});
console.log('BUILD_OK workbuddy-core trae-core');

await import('./verify-workbuddy-channel.mjs');
