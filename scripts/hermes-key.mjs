#!/usr/bin/env node
// Hermes key_cmd helper. stdout is a credential channel, not a diagnostic log.
import fs from 'node:fs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error();
  const {apiKey} = JSON.parse(fs.readFileSync(args[0], 'utf8').replace(/^\uFEFF/, ''));
  if (typeof apiKey !== 'string' || !apiKey || /\s|[\x00-\x1f\x7f]/u.test(apiKey)) throw new Error();
  process.stdout.write(JSON.stringify({access_token: apiKey, expires_in: 65}));
} catch {
  // Do not echo file contents, paths, parser errors, or the admin key.
  process.stderr.write('AI credit gateway local credential unavailable\n');
  process.exitCode = 1;
}
