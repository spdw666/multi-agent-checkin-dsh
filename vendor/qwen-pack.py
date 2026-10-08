import sys,json
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
from dataclasses import asdict
from qwenwork_ref.encode import prepare_infer
try:
 value=json.load(sys.stdin)
 print(json.dumps(asdict(prepare_infer(**value)),ensure_ascii=False))
except Exception as exc:
 print(json.dumps({'error':type(exc).__name__}),flush=True)
 sys.exit(1)
