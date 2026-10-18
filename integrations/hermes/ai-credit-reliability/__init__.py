"""Provider-only retry ownership, using Hermes' supported classifier hook.

No credentials, request bodies, messages or tool outputs are logged/retained.
This plugin does not alter SDK clients or monkeypatch Hermes internals.
"""
import re
from urllib.parse import urlsplit

_ID = re.compile(r"^aigw-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_CODES = frozenset({"provider_auth_rejected", "provider_http_error", "provider_network_error", "relay_target_timeout", "opencode_unauthorized", "loomy_session_expired", "same_model_rate_limited", "same_model_timeout", "same_model_cooldown", "same_model_unavailable", "same_model_credits_exhausted", "relay_context_incompatible", "relay_capacity_incompatible", "relay_attempt_timeout", "request_timeout", "request_deadline_exceeded", "request_cancelled", "account_pool_unavailable", "provider_chat_rejected", "provider_rate_limited", "upstream_rate_limited", "reasoning_effort_not_supported", "reasoning_parameter_not_supported", "invalid_upstream_response", "authentication_error", "tools_not_supported", "images_not_supported", "provider_timeout", "empty_response", "reasoning_only_response"})
_PLATFORMS = frozenset({"loomy", "workbuddy", "workbuddyai", "trae", "trae-cn", "qoder", "qoder-cn", "codebuddy", "codebuddy-cn", "codearts", "lobster", "nvidia", "bigmodel", "freeapi", "opencode", "openai"})


def _gateway_url(error):
    request = getattr(error, "request", None)
    if request is None:
        request = getattr(getattr(error, "response", None), "request", None)
    try:
        url = urlsplit(str(getattr(request, "url", "")))
        return (url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}
                and url.username is None and url.password is None
                and url.path.rstrip("/") == "/v1/chat/completions")
    except (ValueError, TypeError):
        return False


def classify(provider=None, error_body=None, error=None, **kwargs):
    # A remote provider cannot self-declare retry ownership through a header/body.
    # Both the selected named provider and the actual SDK request URL must match.
    if provider not in {"ai-credit", "custom:ai-credit"} or not _gateway_url(error):
        return None
    body = error_body if isinstance(error_body, dict) else {}
    body = body.get("error", body)
    if not isinstance(body, dict):
        return None
    identifier = body.get("gatewayRequestId", "")
    owned = (body.get("gatewayManagedRetry") is True
             and body.get("gatewayRetryOwner") == "gateway"
             and isinstance(identifier, str) and _ID.fullmatch(identifier))
    if not owned:
        request = getattr(error, "request", None)
        headers = getattr(request, "headers", {})
        # This is a deliberate provider-local client policy, not server authority.
        # A lost response has an unknown outcome and must not repeat a paid/tool step.
        opted_in = (headers.get("x-ai-credit-source") == "hermes"
                    and headers.get("x-ai-credit-retry-owner") == "gateway")
        transport = type(error).__name__ in {"APIConnectionError", "APITimeoutError", "ReadError", "ReadTimeout", "ConnectError", "ConnectTimeout", "RemoteProtocolError"}
        if not (opted_in and transport):
            return None
        return {"reason": "unknown", "retryable": False, "should_fallback": False,
                "should_compress": False, "should_rotate_credential": False,
                "message": "AI网关连接中断；本次结果未知，未自动重放原请求",
                "error_context": {"gateway_retry_owner": "gateway", "gateway_outcome": "unknown"}}
    code = body.get("code") if body.get("code") in _CODES else "gateway_terminal_error"
    parts = ["AI网关已完成本次有界恢复", code]
    diagnostic = body.get("relayFailure", {})
    root = diagnostic.get("root", {}) if isinstance(diagnostic, dict) else {}
    if isinstance(root, dict):
        root_code = root.get("code") if root.get("code") in _CODES else "upstream_error"
        platform = root.get("platform") if root.get("platform") in _PLATFORMS else "upstream"
        status = root.get("status")
        if isinstance(status, int) and not isinstance(status, bool) and 400 <= status <= 599:
            parts.append(f"主因 {platform}/{root_code} HTTP {status}")
    parts.append(f"请求 {identifier}")
    return {"reason": "unknown", "retryable": False, "should_fallback": False,
            "should_compress": False, "should_rotate_credential": False,
            "message": "；".join(parts),
            "error_context": {"gateway_request_id": identifier, "gateway_retry_owner": "gateway"}}


def register(ctx):
    ctx.register_hook("transform_api_error_classification", classify)
