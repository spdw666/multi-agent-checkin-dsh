"""Use the selected Hermes dependency tree without bootstrap update/repair."""
import argparse
import os
from pathlib import Path
import runpy
import site
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--test-file", required=True)
parser.add_argument("--baseline", action="store_true")
parser.add_argument("--native-helper")
args = parser.parse_args()
sys.dont_write_bytecode = True
source = Path(args.source).resolve()
sys.path.insert(0, str(source))
from pm.environments import committed_venv, site_packages
selected = site_packages(committed_venv(source))
assert selected.is_dir(), "No committed Hermes dependencies"
site.addsitedir(str(selected))
sys.path.insert(0, str(source))
if args.native_helper:
    os.environ["HERMES_NATIVE_HELPER"] = str(Path(args.native_helper).resolve())
print("RUNTIME=" + sys.version.split()[0] + " SITE=" + str(selected), flush=True)
sys.argv = [str(Path(args.test_file).resolve())] + (["--baseline"] if args.baseline else [])
runpy.run_path(sys.argv[0], run_name="__main__")
