# Native-client automatic updates: design status

This document concerns upgrading native WorkBuddy, TRAE, MiniMax Code, QwenWork, and ZCode applications. It does not describe model-catalog refresh or credential renewal.

**Status: feasibility investigated; the gateway does not yet install or schedule native-client updates.** A Windows Package Manager package ID is an integration candidate, not a guarantee that its current version matches the publisher's latest release.

## Integration candidates

|Application|WinGet package identifier|
|---|---|
|WorkBuddy|`Tencent.WorkBuddy`|
|TRAE CN|`ByteDance.Trae.CN`|
|TraeWork CN|`ByteDance.TraeWork.CN`|
|MiniMax Code|`MiniMax.MiniMaxCode`|
|QwenWork CN|`Alibaba.QwenWork.CN`|
|ZCode|`ZhipuAI.ZCode`|

Package availability and publisher branding may change. Verify the live registry, native executable product version, package manifest, edition, locale, architecture, and installation scope before installing anything.

## Proposed behavior

- Prefer official stable update feeds, with exact WinGet IDs as a fallback. Never downgrade to a lagging community manifest.
- Check independently of the native client's GUI so closed applications can receive maintenance.
- Download first; defer installation while that application is running. Do not terminate active agents, conversations, or gateway streams.
- Validate the publisher URL, manifest hash, and Windows signer before executing a package. Retain the existing install location and account data.
- Install serially and verify the actual installed version. Treat app installation success separately from gateway protocol/model compatibility.
- Keep product migrations, such as TraeWork-to-TRAE account/data migration, separate from ordinary same-product upgrades.
- Do not include Windows or DSH restarts in the native-client updater.

The expected command shape for a validated, idle application is:

```powershell
winget upgrade --id Tencent.WorkBuddy --exact --source winget --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
```

This is an integration example, not an enabled gateway feature. Avoid blanket `upgrade --all`, forced downgrade, unknown-version upgrade, or bypassed package hash verification.

## Primary references

- [Microsoft WinGet upgrade documentation](https://learn.microsoft.com/en-us/windows/package-manager/winget/upgrade)
- [Microsoft Windows Package Manager manifest repository](https://github.com/microsoft/winget-pkgs)
- [Electron update mechanism](https://www.electronjs.org/docs/latest/tutorial/updates)
- [TRAE official product migration instructions](https://docs.trae.cn/ide_traework-to-traecode-data-migration)

This public document intentionally omits machine-specific installation paths, account state, credentials, and dated local snapshots.
