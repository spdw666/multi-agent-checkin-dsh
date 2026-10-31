# Source and license

Source: https://github.com/TriDefender/zcode-api
Commit: 17933d242621d4482ed1ce11c8eaf938b4e08e78
Upstream README.md, `License` section declares MIT. This checkout has no separate LICENSE file.

Reused files: src/proxy/system-prompt.ts, src/proxy/identity.ts,
src/proxy/zcode_system.json. TypeScript annotations were removed using Node's
stripTypeScriptTypes; original comments are preserved. No CAPTCHA solver or
registration automation from that project is incorporated.

Local modifications (this repository, 2026-10-31): `zcode_system.json` now
carries the block-0/block-1 text measured from ZCode client 3.17.1, and
`system-prompt.mjs` keeps the wire `system` array at exactly three blocks by
folding any client-supplied system text into the end of block 2 instead of
appending a fourth block. Both changes are ours, not upstream's; the derived
files stay under the upstream terms above.

Copyright remains with TriDefender/zcode-api contributors.
