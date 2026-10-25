# Exact GLM5V context from the Hermes client registry

For exact `glm-5v-turbo` only, absent/null Lobster context metadata can use 202752 from the independently maintained Hermes client registry. This is **not a Lobster service-advertised capacity and not a manufacturer declaration**. The value is an exact integer in `DEFAULT_CONTEXT_LENGTHS`, not a conversion or guess from the label `200K`.

- Client: Hermes / NousResearch `hermes-agent`.
- Fixed upstream commit: `4bc2efbeb37ac459ee502a76c4e73e1829a033ea`.
- [Source file and exact entry](https://github.com/NousResearch/hermes-agent/blob/4bc2efbeb37ac459ee502a76c4e73e1829a033ea/agent/model_metadata.py#L335): `agent/model_metadata.py`, constant `DEFAULT_CONTEXT_LENGTHS`, exact key `glm-5v-turbo`, value `202752`.
- Source file SHA256: `497f2342915b0c7f23e56c2ec7e191a122d6255a6d12e660e570a4013895ab3d`.

`contextWindowSource` and evidence source are `client_model_registry`; evidence retains `client:Hermes`, exact model ID, commit, source SHA and URL. `officialContextWindow` remains null when Lobster's own context field is absent. Discovery `verification:official_catalog` describes the roster, not this context's provenance or successful inference.

Precedence is positive official context, existing exact Lobster native registry, existing exact manufacturer declaration, then this exact client registry. Explicit zero, negative, fractional, malformed or wrong-type service fields stay unknown; aliases, case variants and other IDs gain no fallback. Caller options and generic selectors do not inject capacities. Existing six Lobster native declarations and the exact Qwen manufacturer declaration keep their original attribution.

Tools, image and thinking declarations, access restrictions, disabled configuration and request bodies are unchanged. Output65536 remains `configured_default` with `officialMaxTokens:null`, not an official output-cap claim. This candidate contains offline fixture validation only, not a live chat or full-tools acceptance result.
