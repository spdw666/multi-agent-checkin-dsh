
### Per-route HTTP request deadlines

server.modelRequestTimeouts optionally maps exact published route IDs to integer milliseconds from 1000 through 1200000. An explicit matching value overrides server.requestTimeoutMs for that HTTP request; other routes retain the general ceiling (default180000). Upstream transport and client cancellation remain independent. Example: {"server":{"modelRequestTimeouts":{"nvidia-main/moonshotai/kimi-k3":600000,"nvidia-main/deepseek-ai/deepseek-v4.1-flash":600000}}}. Renamed routes require corresponding keys. Known upstream concurrency rejections may be normalized to429 while error.upstreamStatus preserves the original400; arbitrary upstream errors are not reclassified.
