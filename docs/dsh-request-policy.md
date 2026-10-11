# DSH request budgets

`createGatewayAdapter({runtime,models})` accepts optional `runtime.maxOutputTokens`, a positive safe integer. It sets the adapter's official `configuredMaxTokens` request default per model, clipped to that model's published `maxTokens`. It does not rewrite catalog capacities, messages, tools or reasoning fields. Omitting the option preserves the previous catalog-driven behavior. Invalid explicit values fail early rather than silently changing generation behavior.

```js
const gateway = createGatewayAdapter({
  runtime: {baseUrl: 'http://127.0.0.1:PORT', key: PRIVATE_LOCAL_KEY, maxOutputTokens: 4096},
  models: officialGatewayDirectory.data,
});
```

The actual DSH adapter supports an idle timer at provider-profile level. The profile therefore uses the longest requested startup/idle interval among its current catalog models, with a default of 180000 ms and maximum of 600000 ms. Gateway model `requestTimeoutMs` is the preferred metadata field so arbitrary user route aliases work. The exact NVIDIA `moonshotai/kimi-k3` model and NVIDIA-route suffix receive a 600000 ms compatibility fallback; other Kimi-family names are not guessed to need a larger interval. A profile containing a Kimi model necessarily shares its larger interval across that provider; a profile containing only regular models remains 180000 ms.

Catalog refresh recalculates both policy fields, including reducing the timer when a slow-start model is removed. Explicit user cancellation and gateway request limits still apply. No third-party package is edited.

Regression coverage: missing/default budget, invalid values, per-model clipping without metadata mutation, metadata aliases, bounded timers, exact model fallback, directory refresh, and the real installed PiAiAdapter model/profile when optional DSH peer packages are present. The optional integration case skips explicitly if those peers are absent; the pure policy tests always run.
