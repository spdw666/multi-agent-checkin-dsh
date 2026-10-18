import {mergeTargets, checkTarget, summarize} from '../src/client-updates.mjs';

const targets = mergeTargets({});
const results = [];
let cursor = 0;
const worker = async () => {
  while (cursor < targets.length) {
    const t = targets[cursor++];
    try {
      const r = await checkTarget(t, {enabled: true}, {timeoutMs: 15000});
      results.push(r);
      console.log([r.status.padEnd(16), (r.installed || '—').padEnd(22), (r.latest || '—').padEnd(22), r.name, r.error ? '| ' + r.error : ''].join(' '));
    } catch (e) {
      results.push({id: t.id, status: 'error', error: e.message});
      console.log('ERROR', t.name, e.message);
    }
  }
};
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(JSON.stringify(summarize(results)));
