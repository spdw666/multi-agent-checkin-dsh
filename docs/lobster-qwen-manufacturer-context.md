# Exact Qwen snapshot manufacturer capacity

For `qwen3.5-plus-2026-04-20` only, absent/null Lobster context metadata falls back to the model manufacturer's exact snapshot declaration of 1,000,000 tokens. A positive Lobster declaration still wins; an explicit invalid/zero/negative value stays unknown. Other IDs, case variants and families receive no new fallback.

- Source: https://www.alibabacloud.com/help/en/model-studio/qwen3-5-plus
- Section: Snapshot Versions / qwen3.5-plus-2026-04-20 / Context Limits
- Captured HTML SHA-256: `11655aaaec6367d0c109629280f21de0bf9d0b2f5aa75a079281690039abe063`
- Extracted text SHA-256: `d84a5b3c1cc5a895c02ba0c513bea91542fae079810cf5e2165bed28ffd7ace2`
- The section declares context 1000000, max input 991808 (thinking 983616), and max output 65536. Only the context declaration is consumed here.

`contextWindowSource` and evidence source are `manufacturer_documentation`; `officialContextWindow` remains null when Lobster's own field is missing. Roster `verification:official_catalog` is unchanged and describes discovery, not this capacity's provenance or a successful chat. Existing output 65536 remains `configured_default` with `officialMaxTokens:null`. Tools, image declarations, access restrictions, disabled settings and inference bodies are unchanged. No production installation or live inference is part of this candidate.

`glm-5v-turbo` remains unknown in the Lobster adapter: public manufacturer pages show `200K`, not an exact numeric token value for this channel. Neither billing tier ceilings nor preset/default windows are capacity evidence.
