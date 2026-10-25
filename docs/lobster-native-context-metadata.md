# Lobster native context metadata

`lobsterModels` keeps a valid positive integer `contextWindow` from the current
service catalog first. If the field is absent or null, only six exact model IDs
use the official native client's pinned registry declaration:

|Exact model ID|Native client context|
|---|---:|
|MiniMax-M2.7|204800|
|qwen3.6-plus|1000000|
|kimi-k2.6|262144|
|kimi-k2.5|262144|
|glm-5.1|202800|
|glm-5|202800|

Source: LobsterAI native version **2026.10.23**, artifact SHA256
`9e64675081a5e9c689b35672ee864ab878df4c88c3bb177ea08dab11b028a7f6`;
`dist-electron/shared/providers/constants.js` SHA256
`9050623fcc7ac0a3eba6ac246fa502e56a8fd69a621e873d28d76d25a2534643`.
The native `ProviderRegistry.resolveModelContextWindow` is called by the
LobsteraiServer OpenClaw config branch and uses exact model IDs. The installed
same-provider configuration independently contains these six values.
[Official registry source](https://github.com/netease-youdao/LobsterAI/blob/main/src/shared/providers/constants.ts).

Rows distinguish `contextWindowSource: native_client_registry` from
`official_catalog`. Native fallback rows keep `officialContextWindow: null`
and carry the version/hash in `contextWindowEvidence`. Existing `verification`
continues to identify the official roster, not a service capacity guarantee.
This is a client metadata declaration, not a generation or agent acceptance.

No options, arbitrary local config values, model aliases, case folding, or generic
200000/400000 selectors extend the six-entry table. Explicit invalid numeric or
wrong-type service fields stay unknown. Future valid official declarations win.
The dated Qwen3.5 ID, GLM5V and Doubao Code preview remain unknown. Tools,
accessible flags, disabled settings and output budgets are not changed.

Validation: `node --test tests/lobster-native-context.test.mjs`.
