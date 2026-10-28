"""Offline WorkBuddy11128 tests for the supported Hermes classifier hook.

Uses only synthetic envelopes and stdlib objects; no model call or private state.
"""
from pathlib import Path
import importlib.util
import os
from types import SimpleNamespace
import unittest

ROOT = Path(os.environ.get("WORKBUDDY_CHANNEL_TEST_ROOT", os.environ.get("GATEWAY_TEST_ROOT", str(Path(__file__).resolve().parents[1]))))
SPEC = importlib.util.spec_from_file_location("aigw_channel_fixture", ROOT / "integrations/hermes/ai-credit-reliability/__init__.py")
PLUGIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLUGIN)
ID = "aigw-12345678-1234-4234-8234-123456789abc"
CODE = "workbuddy_channel_rejected"
HINT = "WorkBuddy 渠道校验未通过（11128）"


def envelope(**extra):
    return {"code": CODE, "upstreamCode": 11128, "gatewayManagedRetry": True,
            "gatewayRetryOwner": "gateway", "gatewayRequestId": ID,
            "message": "SAMPLE_PRIVATE_PROMPT", **extra}


def verdict(body=None, provider="ai-credit", url="http://127.0.0.1:19421/v1/chat/completions"):
    error = SimpleNamespace(request=SimpleNamespace(url=url, headers={}))
    return PLUGIN.classify(provider=provider, error_body={"error": body or envelope()}, error=error)


class WorkBuddyChannelHermes(unittest.TestCase):
    def assert_terminal(self, value):
        self.assertIsNotNone(value)
        for field in ("retryable", "should_fallback", "should_compress", "should_rotate_credential"):
            self.assertIs(value[field], False)
        self.assertIn(HINT, value["message"])
        self.assertNotIn("SAMPLE_PRIVATE", str(value))
        self.assertEqual(value["error_context"]["upstream_code"], 11128)

    def test_direct_owned_channel_rejection_is_explicit_terminal(self):
        self.assert_terminal(verdict())

    def test_aggregate_retains_channel_root_and_no_credentials(self):
        self.assert_terminal(verdict(envelope(code="same_model_unavailable", relayFailure={
            "root": {"platform": "workbuddy", "code": CODE, "status": 400, "body": "SAMPLE_PRIVATE_PROMPT"}})))

    def test_custom_named_gateway_uses_same_single_owner(self):
        self.assert_terminal(verdict(provider="custom:ai-credit"))

    def test_other_provider_is_not_claimed(self):
        self.assertIsNone(verdict(provider="OTHER"))

    def test_remote_endpoint_cannot_claim_local_retry_owner(self):
        self.assertIsNone(verdict(url="https://example.invalid/v1/chat/completions"))

    def test_forged_request_id_is_not_claimed(self):
        self.assertIsNone(verdict(envelope(gatewayRequestId="SAMPLE_FORGED")))

    def test_unowned_channel_response_is_not_claimed(self):
        self.assertIsNone(verdict(envelope(gatewayManagedRetry=False)))

    def test_unrelated_numeric11128_does_not_acquire_channel_diagnostic(self):
        value = verdict(envelope(code="provider_chat_rejected"))
        self.assertNotIn(HINT, value["message"])
        self.assertNotIn("upstream_code", value["error_context"])

    def test_existing_other_root_diagnostic_stays_unchanged(self):
        value = verdict(envelope(code="same_model_unavailable", upstreamCode=6004, relayFailure={
            "root": {"platform": "loomy", "code": "loomy_session_expired", "status": 401}}))
        self.assertIn("loomy/loomy_session_expired HTTP 401", value["message"])
        self.assertNotIn(HINT, value["message"])
        self.assertFalse(value["retryable"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
