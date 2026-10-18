"""Read-only installation guard/plan. Never writes the Hermes home or source."""
import argparse
import hashlib
import json
from pathlib import Path
import yaml

parser = argparse.ArgumentParser()
parser.add_argument("--home", required=True)
parser.add_argument("--source", required=True)
args = parser.parse_args()
home, source = Path(args.home).resolve(), Path(args.source).resolve()
config = home / "config.yaml"
native = source / "agent/chat_completion_helpers.py"
baseline = "d7b982ddeabe7bb02cb92fd905d213ecba3b2d21672e249510f760fff27ec8a1"
assert hashlib.sha256(native.read_bytes()).hexdigest() == baseline, "Hermes native file changed: merge against current source before installation"
cfg = yaml.safe_load(config.read_text(encoding="utf-8-sig"))
provider = cfg.get("providers", {}).get("ai-credit")
assert isinstance(provider, dict), "Missing named ai-credit provider"
assert provider.get("base_url", "").rstrip("/") == "http://127.0.0.1:19421/v1", "Gateway endpoint changed: re-evaluate this route"
plugin = home / "plugins/ai-credit-reliability"
assert not plugin.exists(), "Plugin destination exists: inspect before merging"
plugins = cfg.get("plugins", {})
enabled, disabled = plugins.get("enabled", []), plugins.get("disabled", [])
assert isinstance(enabled, list) and isinstance(disabled, list), "Unexpected plugin config schema"
overrides = provider.get("models", {})
short = []
if isinstance(overrides, dict):
    for entry in overrides.values():
        if isinstance(entry, dict):
            for key in ("timeout_seconds", "stale_timeout_seconds"):
                if key in entry and (not isinstance(entry[key], (int, float)) or entry[key] < 1210):
                    short.append(key)
assert not short, "Per-model timeout overrides need route-aware review"
replacement = Path(__file__).parent / "native-patch/agent/chat_completion_helpers.py"
print(json.dumps({"mode": "plan_only", "configPath": str(config),
    "configSha256": hashlib.sha256(config.read_bytes()).hexdigest(), "providerKey": "ai-credit",
    "nativePath": str(native), "nativeBaselineSha256": baseline,
    "nativeModifiedSha256": hashlib.sha256(replacement.read_bytes()).hexdigest(),
    "pluginDestination": str(plugin), "pluginEnabledAppend": "ai-credit-reliability",
    "enabledOtherPluginCount": len([x for x in enabled if x != "ai-credit-reliability"]),
    "disabledRemoveOnlyTarget": "ai-credit-reliability" in disabled,
    "providerHeaderMerge": {"X-AI-Credit-Source": "hermes", "X-AI-Credit-Retry-Owner": "gateway"},
    "providerSet": {"request_timeout_seconds": 1210, "stale_timeout_seconds": 1210},
    "preserve": "all other config fields, providers, model selection, keys, headers, user data"}, indent=2))
