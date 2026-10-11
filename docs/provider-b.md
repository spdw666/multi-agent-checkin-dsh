# Provider B: Qoder / CodeBuddy / WorkBuddyAI

## Sources and reuse

- Official Qoder CN daily credits: https://docs.qoder.cn/events/100credits . The active campaign governs eligibility, value, expiration and claim status. The documented daily boundary is 10:00 Asia/Shanghai. We do not infer eligibility from marketing pages.
- Official Qoder credits: https://docs.qoder.com/Credits . Campaign and quota information are queried for the real signed-in account.
- MIT implementation reference: https://github.com/jsongo/buddy-proxy , commit `cab81ff4fc5eaf4d64dffe1ea560a6e23972af3f`. Qoder COSY signing/body encoding/request envelope/SSE transformation were adapted to Node built-in crypto and Web Streams. Local metadata remains authoritative, not this project's fallback catalog.
- WorkBuddy check-in comparison: https://github.com/Maquer/workbuddy-checkin ; existing gateway `vendor/workbuddy-core.mjs` is reused for model parsing, CLI model selection, tool/message preparation and DSML recovery contract.
- Native desktop evidence: Qoder application main bundle resolves global inference at `https://api2.qoder.sh`; this endpoint returned a signed model directory and successful text responses. We do not silently substitute another region.

## Files / integration exports

- `src/provider-http.mjs`: fixed official HTTPS domains, optional loopback HTTP proxy, standard TLS validation, no redirects, header/body timeouts, bounded 4 MiB JSON, generic secret-free errors.
- `src/provider-qoder.mjs`: `qoderProvider` with resolve/models/health/status/claim/chat.
- `src/provider-buddy.mjs`: `codeBuddyProvider`, `workBuddyAIProvider` with the same interface.
- Tests: `tests/provider-buddy.test.mjs`, `tests/provider-qoder.test.mjs`.

Every resolve returns private `accessToken`, `principal`, local source reference and explicit region/domain. None of these tokens belong in account config or published evidence. The preferred credentials shape is `{kind:'desktop',file:'auto',proxyUrl:'http://127.0.0.1:7890'}`; omit proxyUrl to use direct networking. Only local reference configuration is persisted. No default route or client configuration is altered by these modules.

### Native sources

| App | Region | Read-only source |
| --- | --- | --- |
| Qoder | global | `%APPDATA%/com.qoder.app.stable/auth.v1.dat`, `Local State`, `auth.machine-id`; original `D:/Qoder/resources/umid/runtime-info.exe` |
| Qoder CN | cn | `%APPDATA%/com.qodercn.app.stable/auth.v1.dat`, `Local State`, `auth.machine-id`; original `D:/Qoder CN/resources/umid/runtime-info.exe` |
| CodeBuddy | global | `%APPDATA%/CodeBuddy/User/globalStorage/state.vscdb` exact `planning-genie.new.accessToken` secret and its `Local State` |
| CodeBuddy CN | cn | `%APPDATA%/CodeBuddy CN/User/globalStorage/state.vscdb` exact `planning-genie.new.accessTokencn` secret and its `Local State` |
| WorkBuddyAI | global | `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info`, decrypted using existing native helper against `D:/WorkBuddyAI/WorkBuddyAI.exe` |

Qoder uses its installed runtime-info executable with the real account identifier on stdin; no generated device identity is used. Desktop DPAPI/AES-GCM reads do not rewrite app storage, refresh login state, or change defaults. `file` mode accepts a private normalized JSON for headless deployments, but users need not export native tokens for normal local operation.

## Observed API / accounting

Qoder account operations: authenticated `/api/v2/quota/usage`, `/sash/api/v1/me/campaigns`; eligible credit benefits only use `/{campaignId}/claim`, then `/{campaignId}/reward`, refreshed campaigns and quota. Reward vouchers and achievement-unmet campaigns are not daily credits. Already-claimed campaigns do not send another claim POST. `status` exposes `active,known,claimed,claimable,credits,day,campaignWindowId,nextClaimAt`; day is the 10:00 reset window, not midnight. Claim returns numeric `credit` for newly acknowledged rewards, numeric `credits` status and separate `quota`.

Qoder models come exclusively from signed `/algo/api/v2/model/list?Encode=1` for that account/region. Context length is the official `max_input_tokens`. Missing context means `callable:false`. Missing official output cap is explicitly `officialMaxTokens:null`, `maxTokensSource:'configured_default'`, a local cap of 1024, not an invented upstream maximum. Tools use the reviewed COSY OpenAI-envelope protocol; real four-stage tool tests are separately recorded. The response model may be the upstream generic `auto`; gateway routing retains the selected model key.

Buddy models come from authenticated `/v3/config`, parsed by the existing official-schema adapter. CN inference uses `copilot.tencent.com`, billing uses `www.codebuddy.cn`; global CodeBuddy uses `www.codebuddy.ai`, WorkBuddyAI uses `www.workbuddy.ai`. Regional credentials are never silently moved across these domains.

Buddy billing reads POST `/v2/billing/meter/checkin-activity-status` and `/v2/billing/meter/get-user-resource`; claims POST `/v2/billing/meter/daily-checkin` and recheck service status. No active activity means `supportsCheckin:false`, not successful check-in. Balance and check-in fail independently; for example a resources 403 does not erase a successful activity-status observation. CN CodeBuddy and the existing CN WorkBuddy have the same verified local principal and billing authority; configure the CodeBuddy account with no duplicate tasks and reference the existing WorkBuddy claim owner. Resolve also returns billingPlatform/billingPrincipal for root-level de-duplication.

## Verified state and remaining checks

- Qoder global signed catalog: 18 rows, 17 with usable documented context; CN: 14/14. One global Kimi entry has missing capacity and stays visible but non-callable.
- Qoder global initial quota 498 Credits (298 plan + 200 add-on), CN 400 (300 + 100). Both active 100-credit campaigns were already CLAIMED. No repeat claim was issued.
- CodeBuddy CN: 17 models; daily activity active and already checked in, streak 7, today 100. Initial resource-pack request returned HTTP 403; the final adapter with region-correct headers subsequently returned 852 credits after successful four-stage inference. Historical failure is retained in preflight.json; current success is in four-chain.json. Its principal matches the already-integrated CN WorkBuddy account.
- WorkBuddyAI global: 25 models, initial 350 credits (250 bonus + 100 monthly); activity active=false, so no independent daily claim is offered.
- CodeBuddy international credential is locally decrypted and region-verified. Initial proxy requests failed during TLS setup; bounded direct and loopback-proxy comparisons both timed out. This is network-unverified, not proof of logged-out status.
- Qoder real text probes returned HTTP 200, PONG, finish_reason stop, usage and terminal DONE in both regions. The four tested providers (Qoder CN, Qoder global, CodeBuddy CN and WorkBuddyAI; excluding CodeBuddy international) passed ordinary/stream/tools/roundtrip (16/16 live stages), with audit_add(2,3) and returned result 5. Four-stage Router tests are saved as `outputs/platform-expansion/providers-b/four-chain.json`.
- No app installation, default selection, production route, service process or shared account configuration was changed by this provider task.

## Protocol fixes proven during live validation

COSY inference requires `Accept: text/event-stream`; JSON Accept produced HTTP 500 even with a valid signature. Successful streams wrap JSON chunks and the literal `[DONE]` in `body`; the adapter unwraps both and ignores the diagnostic finish event. It preserves tool deltas and usage. Truncation, in-band failure, malformed JSON, cancellation and oversized frames fail rather than completing a false success. Developer roles become system, and tool-call messages receive non-null content while preserving caller objects.

## MIT notice for adapted COSY implementation

Copyright (c) 2026 Mayer

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Actual client integration validation

Six isolated HTTP client probes passed: Qoder CN, CodeBuddy CN and WorkBuddyAI each on actual DSH and actual Hermes. Each model read one non-sensitive random fixture with a real file tool, sent its tool result in the next model request, and returned the same marker. A run-specific CLI patch/runtime reference was used, not a default-model change. Evidence: `outputs/platform-expansion/providers-b/clients/stage-verified.json`. Installed port 19421 acceptance is a separate later phase. Earlier unsuccessful attempts are retained, not overwritten or relabeled.

The first DSH attempt exposed invalid reasoning metadata: reasoning=true with no selectable effort is rejected by DSH. Qoder now retains `isReasoning` for its internal COSY envelope but does not invent configurable effort options. The shared Router maps genuine Buddy supportedEfforts for CodeBuddy and WorkBuddyAI. A real native identity result is cached for five minutes by helper path, account uid and auth-file mtime to avoid repeated runtime-info helper startup during tool turns; current OAuth token is always re-read. Failure is never cached or fabricated, and expired cache does not mask a failed refresh. Offline tests cover each cache boundary and client metadata shape.

## International endpoint and transport diagnostics

CodeBuddy international remains pinned to `https://www.codebuddy.ai`; CN uses `https://copilot.tencent.com` for inference with `X-Domain: www.codebuddy.cn`. Credentials remain region-bound. Network failure is not converted into logged-out state, and no CN endpoint is substituted for an international account.

Sources: the installed official `D:/CodeBuddy/resources/app/product-ide.json` (`endpoint` and `genieEndpoint`), official [environment reference](https://www.codebuddy.ai/docs/cli/env-vars) and [troubleshooting](https://www.codebuddy.ai/docs/ide/Support/Troubleshooting), and [buddy-proxy](https://github.com/jsongo/buddy-proxy) at `cab81ff4fc5eaf4d64dffe1ea560a6e23972af3f` (`codebuddy_provider/intl_provider.py` and `credentials.py`). The GitHub reference remains protocol corroboration; this diagnostic change copies no additional upstream program.

On the observed host, HTTP CONNECT succeeds but the international-host TLS handshake does not complete. Another official sibling host, `www.workbuddy.ai`, responds HTTP 200 using the same existing loopback proxy. Public resolver results differ: the CodeBuddy official CNAME resolves to an official CDN address while some A responses are `0.0.0.1`. These are diagnostic observations, not proof that changing account credentials or selecting a guessed endpoint fixes service reachability. Full evidence is in `outputs/platform-completion/buddy-global/DIAGNOSIS.md` and `final-transport.json`.

The shared official-host transport now classifies header deadlines as `provider_timeout` / HTTP 504, reports a credential-free `networkPhase` and allowlisted `transportCode`, and settles caller cancellation/deadline without waiting for a delayed native proxy-agent error. A socket delivered after cancellation is immediately destroyed. Original upstream error messages and arbitrary error codes never enter public errors. No TLS validation, host allowlist or region separation was relaxed. Authentication, model generation and actual client acceptance remain separate from transport reachability.
