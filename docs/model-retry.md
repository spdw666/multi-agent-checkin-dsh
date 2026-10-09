# Targeted model retesting

Model discovery is not proof that a model is callable. Availability reports distinguish ordinary completion, streaming, structured tool calls, and tool-result roundtrips. A temporary timeout, disconnect, or rate limit is not permanent model unavailability.

## Retry previously non-passed entries

Use the existing authenticated management API:

```http
POST /admin/model-tests
Authorization: Bearer ADMIN_KEY
Content-Type: application/json

{"scope":"retry"}
```

The scope selects prior `failed`, `partial`, `uncertain`, and `unavailable` entries whose upstream and account remain enabled. It refreshes each relevant catalog, runs each selected model once, and leaves configured routes and user enable/disable choices unchanged. Previously passed unrelated entries retain their timestamp and result.

The service shares active audit work instead of starting a second writer. A different requested scope is queued behind the current audit. Use authenticated `GET /admin/model-tests` to inspect `scope`, `status`, `total`, `completed`, `jobKeys`, and `summary`. The summary covers the current job keys, not every historical model in `results`.

Each retested entry retains up to five preceding attempts. A recovered catalog failure is removed when real model entries are available. Missing wire mappings stay `unavailable`; the gateway does not substitute another model to make a test pass.

The CLI helper talks to the already-running local service and reads its key from the local data directory without printing it:

```sh
node scripts/retest-models.mjs /absolute/path/to/config.local.json
```

Run it after starting the gateway. Completion of the audit does not imply every selected model passed: inspect each `RETEST` line and `RETEST_SUMMARY`. Authentication failures, service failures, and the bounded wait timeout produce a nonzero exit status.

## ZCode entitlement diagnostics

The ZCode catalog comes from unexpired model entitlements with positive available units. The adapter distinguishes:

|Code|Meaning|
|---|---|
|`zcode_no_active_entitlement` (402)|The account currently has no unexpired positive model allowance. Check the native client plan/quota and retest after it changes.|
|`zcode_balance_schema` (502)|The billing response omitted the required balances array; investigate upstream schema changes.|
|`zcode_model_capability_missing` (502)|An active balance exists but does not declare a usable model capability.|

An account-level allowance problem is not evidence that the model is permanently unavailable. The adapter does not manufacture catalog entries or invoke a different model.

## Regression checks

```sh
npm run check
node --test tests/model-retry.test.mjs
```

The fixtures cover selected scopes, preserved history/routes, disabled accounts, duplicate catalog/model jobs, authenticated API isolation, and entitlement/schema/capability classification. They do not consume live model quota.
