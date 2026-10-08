// Invoke the Desktop's existing CLI without changing its launchers or immutable runtime.
import {join} from 'node:path';
import {access} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const resources=process.env.DSH_DESKTOP_RESOURCES??join(process.env.LOCALAPPDATA??'','Programs/DeepSeek Harness/resources');
const runtime=join(resources,'app/dsh');
const cli=process.env.DSH_CLI_FILE??join(runtime,'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
await access(cli);
const {runDesktopCli}=await import(pathToFileURL(cli));
await runDesktopCli(runtime,join(resources,'runtime'));
