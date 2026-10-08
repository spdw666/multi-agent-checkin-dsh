#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e "if(+process.versions.node.split('.')[0]<24)process.exit(1)"
npm ci
npm run build
if [ ! -f config.local.json ]; then node bin/ai-credit.mjs init; fi
if [ "${1:-}" != "--no-start" ]; then node bin/ai-credit.mjs start; fi
printf '%s\n' 'SETUP_OK headless gateway; configure local credentials and run doctor.'
