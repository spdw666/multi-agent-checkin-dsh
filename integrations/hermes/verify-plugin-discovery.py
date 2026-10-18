"""Read actual home config, discover/gate/load ONLY the named integration.

No other enabled plugin is activated by this verification process. This is a
targeted official loader check, not an assertion that Hermes GUI was restarted.
"""
import argparse
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--home", required=True)
parser.add_argument("--source", required=True)
args = parser.parse_args()
os.environ["HERMES_HOME"] = str(Path(args.home).resolve())
sys.path.insert(0, str(Path(args.source).resolve()))
from hermes_cli import plugins
from hermes_cli.plugins_discovery import collect_directory_manifests, gate_manifest, _get_enabled_plugins, _get_disabled_plugins
from hermes_cli.plugins_manifest import manifest_key

name = "ai-credit-reliability"
manifests = [m for m in collect_directory_manifests() if manifest_key(m) == name]
assert len(manifests) == 1, "Expected exactly one target plugin in actual user home"
manifest = manifests[0]
assert manifest.source == "user", "Target must come from the user plugin directory"
gate = gate_manifest(manifest, _get_disabled_plugins(), _get_enabled_plugins())
assert gate.action == "load", "Target is not explicitly enabled by config"
manager = plugins.PluginManager()
plugins._plugin_manager = manager
# Preserve the real collection/manifest/gate; avoid activating unrelated backends
# or the user's other enabled plugins in a headless verification process.
manager._collect_directory_manifests = lambda: [manifest]
manager._scan_entry_points = lambda: []
manager.discover_and_load()
loaded = manager._plugins.get(name)
assert loaded and loaded.enabled and not loaded.error, "Official plugin load failed"
assert manager.has_hook("transform_api_error_classification")
callbacks = manager._hooks.get("transform_api_error_classification", [])
assert len(callbacks) == 1, "Expected exactly one target hook registration"
print(json.dumps({"plugin": name, "source": manifest.source, "path": str(manifest.path),
                  "gate": gate.action, "enabled": loaded.enabled, "hookCount": len(callbacks),
                  "otherPluginsLoaded": 0, "verification": "official target-only discovery/gate/loader"}))
manager.unload()
