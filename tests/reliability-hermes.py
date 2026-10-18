"""Offline tests against the installed Hermes runtime and its actual stream function.

Use --baseline for the frozen native helper with no new plugin. No real config,
network connection, SDK generation or user conversation is opened.
"""
from pathlib import Path
import importlib.util
import os
import sys
import unittest
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

HERE = Path(__file__).resolve()
STAGE = HERE.parents[1]
WORK = STAGE.parent
BASELINE = "--baseline" in sys.argv
if BASELINE:
    sys.argv.remove("--baseline")
HERMES = Path(os.environ.get("HERMES_SOURCE", str(Path.home() / "AppData/Local/hermes/hermes-agent")))
sys.path.insert(0, str(HERMES))
import httpx
import openai
import hermes_cli.plugins as plugins
from agent.error_classifier import classify_api_error


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


native_path = Path(os.environ["HERMES_NATIVE_HELPER"]) if os.environ.get("HERMES_NATIVE_HELPER") else (WORK / "hermes-original/agent/chat_completion_helpers.py" if BASELINE else STAGE / "integrations/hermes/native-patch/agent/chat_completion_helpers.py")
native = load("agent.aigw_test_chat_helpers", native_path)
manager = plugins.PluginManager()
plugins._plugin_manager = manager
if not BASELINE:
    plugin = load("aigw_reliability_test_plugin", STAGE / "integrations/hermes/ai-credit-reliability/__init__.py")
    plugin.register(SimpleNamespace(register_hook=lambda name, cb: manager._hooks.setdefault(name, []).append(cb)))

ID = "aigw-12345678-1234-4234-8234-123456789abc"
BODY = {"code": "same_model_unavailable", "type": "same_model_unavailable", "gatewayManagedRetry": True,
        "gatewayRetryOwner": "gateway", "gatewayRequestId": ID,
        "message": "SAMPLE_SECRET_DO_NOT_DISPLAY",
        "relayFailure": {"root": {"platform": "loomy", "code": "loomy_session_expired", "status": 401,
                                  "message": "SAMPLE_SECRET_DO_NOT_DISPLAY"}}}


def request(url="http://127.0.0.1:19421/v1/chat/completions", opted=True):
    return httpx.Request("POST", url, headers={"x-ai-credit-source": "hermes", "x-ai-credit-retry-owner": "gateway"} if opted else {})


def error(status=503, body=BODY, url="http://127.0.0.1:19421/v1/chat/completions"):
    req = request(url)
    response = httpx.Response(status, request=req, json={"error": body})
    return openai.APIStatusError("SAMPLE_SECRET_DO_NOT_DISPLAY", response=response, body=body)


def stream_call(provider="ai-credit", partial=False):
    # Invoke the actual production method; only wire side effects are counters.
    call = native._StreamingCall.__new__(native._StreamingCall)
    counters = {"replay": 0, "unmask": 0}
    call.agent = SimpleNamespace(provider=provider, model="SAMPLE_MODEL", _stream_options_unsupported=False,
        _is_provider_stream_parse_error=lambda e: False, _warning_presentation_enabled=lambda: False,
        _reset_stream_delivery_tracking=lambda: None)
    call._request_cancelled = {"value": False}
    call.deltas_were_sent = {"yes": partial}
    call.provider_tool_in_flight = {"yes": partial}
    call.first_delta_fired = {"done": partial}
    call.result = {"error": None, "partial_tool_names": ["SAMPLE_TOOL"] if partial else []}
    call._visible_text_delivered = lambda: True
    call._maybe_disable_streaming = lambda e: None
    call._retry_after_drop = lambda *a, **kw: counters.__setitem__("replay", counters["replay"] + 1)
    call._unmask_server_error_with_nonstreaming = lambda e: counters.__setitem__("unmask", counters["unmask"] + 1) or True
    return call, counters


class HermesContract(unittest.TestCase):
    def test_01_owned_terminal_http_is_not_outer_replayed(self):
        result = classify_api_error(error(), provider="ai-credit", model="SAMPLE_MODEL", base_url="http://127.0.0.1:19421/v1")
        self.assertFalse(result.retryable)
        self.assertFalse(result.should_fallback)
        self.assertFalse(result.should_compress)
        self.assertIn("loomy/loomy_session_expired HTTP 401", result.message)
        self.assertNotIn("SAMPLE_SECRET", result.message)

    def test_02_other_provider_keeps_existing_retry(self):
        self.assertTrue(classify_api_error(error(), provider="OTHER", model="SAMPLE_MODEL").retryable)

    def test_03_remote_endpoint_cannot_claim_local_gateway_policy(self):
        self.assertTrue(classify_api_error(error(url="https://example.invalid/v1/chat/completions"), provider="ai-credit").retryable)

    def test_04_forged_owner_without_minted_id_is_not_claimed(self):
        self.assertTrue(classify_api_error(error(body={**BODY, "gatewayRequestId": "SAMPLE_FORGED"}), provider="ai-credit").retryable)

    def test_05_actual_stream_5xx_does_not_make_nonstream_generation_probe(self):
        call, counts = stream_call()
        e = error()
        self.assertFalse(call._handle_stream_error(e, 0, 2))
        self.assertEqual(counts, {"replay": 0, "unmask": 0})
        self.assertIs(call.result["error"], e)

    def test_06_other_provider_retains_nonstream_probe(self):
        call, counts = stream_call("OTHER")
        self.assertFalse(call._handle_stream_error(error(), 0, 2))
        self.assertEqual(counts["unmask"], 1)

    def test_07_transport_unknown_outcome_not_replayed_or_compressed(self):
        e = httpx.ReadTimeout("SAMPLE_TRANSPORT", request=request())
        verdict = classify_api_error(e, provider="ai-credit")
        self.assertFalse(verdict.retryable)
        self.assertFalse(verdict.should_compress)
        self.assertFalse(verdict.should_fallback)
        self.assertEqual(verdict.error_context["gateway_outcome"], "unknown")

    def test_08_actual_transport_stream_has_no_inner_retry(self):
        call, counts = stream_call()
        e = httpx.ReadTimeout("SAMPLE_TRANSPORT", request=request())
        self.assertFalse(call._handle_stream_error(e, 0, 2))
        self.assertEqual(counts, {"replay": 0, "unmask": 0})

    def test_09_partial_tool_stream_is_not_replayed(self):
        call, counts = stream_call(partial=True)
        e = httpx.ReadError("SAMPLE_PARTIAL_DISCONNECT", request=request())
        self.assertFalse(call._handle_stream_error(e, 0, 2))
        self.assertEqual(counts, {"replay": 0, "unmask": 0})

    def test_10_other_provider_partial_tool_retry_is_unchanged(self):
        call, counts = stream_call("OTHER", partial=True)
        self.assertTrue(call._handle_stream_error(httpx.ReadError("SAMPLE", request=request()), 0, 2))
        self.assertEqual(counts["replay"], 1)

    def test_11_cancellation_never_retries(self):
        call, counts = stream_call()
        call._request_cancelled["value"] = True
        self.assertFalse(call._handle_stream_error(error(), 0, 2))
        self.assertEqual(counts, {"replay": 0, "unmask": 0})

    def test_12_transient_official_429_owner_stays_gateway(self):
        body = {**BODY, "code": "same_model_rate_limited", "type": "same_model_rate_limited", "rateLimitKind": "transient",
                "rateLimitRetryable": True, "retryAfterSource": "official_header", "retryAfterSeconds": 1}
        result = classify_api_error(error(status=429, body=body), provider="custom:ai-credit")
        self.assertFalse(result.retryable)
        self.assertFalse(result.should_fallback)

    def test_13_transport_without_provider_optin_keeps_default(self):
        e = httpx.ReadTimeout("SAMPLE", request=request(opted=False))
        self.assertTrue(classify_api_error(e, provider="ai-credit").retryable)

    def test_14_actual_openai_sdk_http_response_keeps_owner_and_single_wire_request(self):
        hits = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                hits.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
                wire = json.dumps({"error": BODY}).encode()
                self.send_response(503)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(wire)))
                self.send_header("x-should-retry", "false")
                self.end_headers()
                self.wfile.write(wire)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with openai.OpenAI(api_key="SAMPLE", base_url=f"http://127.0.0.1:{server.server_port}/v1", max_retries=0) as client:
                with self.assertRaises(openai.APIStatusError) as captured:
                    client.chat.completions.create(model="SAMPLE", messages=[{"role": "user", "content": "SAMPLE"}])
                result = classify_api_error(captured.exception, provider="ai-credit")
                self.assertFalse(result.retryable)
                self.assertIn(ID, result.message)
            self.assertEqual(len(hits), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_15_actual_sdk_sse_tool_partial_and_terminal_owner_is_not_replayed(self):
        hits = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                hits.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
                tool = {"id": "SAMPLE", "object": "chat.completion.chunk", "created": 1, "model": "SAMPLE", "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "SAMPLE_TOOL", "type": "function", "function": {"name": "SAMPLE_READ", "arguments": "{"}}]}, "finish_reason": None}]}
                wire = ("data: " + json.dumps(tool) + "\n\nevent: error\ndata: " + json.dumps({"error": BODY}) + "\n\n").encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(wire)))
                self.end_headers()
                self.wfile.write(wire)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with openai.OpenAI(api_key="SAMPLE", base_url=f"http://127.0.0.1:{server.server_port}/v1", max_retries=0) as client:
                stream = client.chat.completions.create(model="SAMPLE", messages=[{"role": "user", "content": "SAMPLE"}], stream=True)
                chunks = []
                with self.assertRaises(openai.APIError) as captured:
                    for chunk in stream:
                        chunks.append(chunk)
                self.assertEqual(chunks[0].choices[0].delta.tool_calls[0].id, "SAMPLE_TOOL")
                call, counts = stream_call(partial=True)
                self.assertFalse(call._handle_stream_error(captured.exception, 0, 2))
                self.assertEqual(counts, {"replay": 0, "unmask": 0})
                self.assertFalse(classify_api_error(captured.exception, provider="ai-credit").retryable)
            self.assertEqual(len(hits), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
