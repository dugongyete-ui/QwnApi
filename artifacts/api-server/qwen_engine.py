#!/usr/bin/env python3
"""
Qwen Gateway Engine — WAF bypass using curl_cffi for TLS fingerprint spoofing.
Reads JSON input from stdin, writes JSON result to stdout.
Supports full OpenAI-compatible generation parameters.
"""

import sys
import json
import uuid
import os

try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    import urllib.request
    import urllib.error
    HAS_CURL_CFFI = False


QWEN_BASE = "https://chat.qwen.ai/api/v2"
DEFAULT_IMPERSONATE = "chrome120"

# Optional session cookie — set QWEN_COOKIE env var to your browser session cookie
# to bypass the WAF challenge that blocks anonymous requests.
QWEN_COOKIE = os.environ.get("QWEN_COOKIE", "").strip()


def _is_waf_response(text: str, status: int) -> bool:
    """Detect Alibaba WAF challenge page (returns 200 but is HTML)."""
    if not text:
        return False
    low = text.lstrip().lower()
    return (
        low.startswith("<!doctype") or
        low.startswith("<html") or
        "aliyun_waf" in low or
        "_waf_is_mob" in low or
        "distil_r_captcha" in low
    )


def get_headers(midtoken: str) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://chat.qwen.ai",
        "Referer": "https://chat.qwen.ai/",
        "X-Requested-With": "XMLHttpRequest",
        "bx-umidtoken": midtoken,
        "bx-v": "2.5.31",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }
    if QWEN_COOKIE:
        headers["Cookie"] = QWEN_COOKIE
    return headers


def create_chat(midtoken: str, model: str) -> dict:
    """Create a new conversation session and return its ID."""
    payload = {
        "model": model,
        "stream": False,
        "incremental_output": False,
        "messages": [],
    }

    url = f"{QWEN_BASE}/chat/create"
    headers = get_headers(midtoken)

    try:
        if HAS_CURL_CFFI:
            resp = cffi_requests.post(
                url,
                json=payload,
                headers=headers,
                impersonate=DEFAULT_IMPERSONATE,
                timeout=30,
            )
            raw = resp.text
            status = resp.status_code
        else:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode(),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                status = r.status

        if _is_waf_response(raw, status):
            # WAF blocked — generate a local UUID so the caller can still proceed
            # (the real failure will surface in chat_completions)
            return {"success": False, "error": "WAF_BLOCKED", "code": "WAF_BLOCKED", "chatId": str(uuid.uuid4())}

        data = json.loads(raw)
        chat_id = data.get("data", {}).get("chat", {}).get("id") or data.get("id")
        if not chat_id:
            chat_id = str(uuid.uuid4())

        return {"success": True, "chatId": chat_id}

    except Exception as e:
        return {"success": False, "error": str(e), "chatId": str(uuid.uuid4())}


def chat_completions(
    midtoken: str,
    model: str,
    messages: list,
    chat_id: str,
    # Generation parameters — passed through to Qwen where supported
    temperature: float = None,
    top_p: float = None,
    max_tokens: int = None,
    stop=None,
    presence_penalty: float = None,
    frequency_penalty: float = None,
    seed: int = None,
    response_format: dict = None,
    tools: list = None,
    tool_choice=None,
    reasoning_effort: str = None,
) -> dict:
    """Send messages and return the AI response."""

    # Build system message for JSON mode
    final_messages = list(messages)
    if response_format and response_format.get("type") == "json_object":
        has_system = any(m.get("role") == "system" for m in final_messages)
        json_instruction = "You must respond with valid JSON only. Do not include markdown, explanations, or any text outside the JSON object."
        if has_system:
            final_messages = [
                {**m, "content": m["content"] + "\n\n" + json_instruction} if m.get("role") == "system" else m
                for m in final_messages
            ]
        else:
            final_messages = [{"role": "system", "content": json_instruction}] + final_messages

    # Adjust model for reasoning effort
    if reasoning_effort in ("high", "medium"):
        # Map to thinking-capable Qwen models
        if "qwen3" not in model and "max" not in model:
            model_override = "qwen3.7-plus"
        else:
            model_override = model
    else:
        model_override = model

    payload = {
        "model": model_override,
        "messages": final_messages,
        "stream": False,
        "incremental_output": False,
        "chat_id": chat_id,
        "id": str(uuid.uuid4()),
    }

    # Pass through supported generation parameters
    if temperature is not None:
        payload["temperature"] = float(temperature)
    if top_p is not None:
        payload["top_p"] = float(top_p)
    if max_tokens is not None:
        payload["max_tokens"] = int(max_tokens)
    if stop is not None:
        payload["stop"] = stop if isinstance(stop, list) else [stop]
    if presence_penalty is not None:
        payload["presence_penalty"] = float(presence_penalty)
    if frequency_penalty is not None:
        payload["repetition_penalty"] = 1.0 + float(frequency_penalty)
    if seed is not None:
        payload["seed"] = int(seed)

    url = f"{QWEN_BASE}/chat/completions"
    headers = get_headers(midtoken)

    try:
        if HAS_CURL_CFFI:
            resp = cffi_requests.post(
                url,
                json=payload,
                headers=headers,
                impersonate=DEFAULT_IMPERSONATE,
                timeout=120,
            )
            raw = resp.text
            status = resp.status_code
        else:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode(),
                headers=headers,
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    raw = r.read().decode()
                    status = r.status
            except urllib.error.HTTPError as e:
                raw = e.read().decode()
                status = e.code

        if status == 401 or "FAIL_SYS_USER_VALIDATE" in raw:
            return {
                "success": False,
                "error": "Token validation failed",
                "code": "TOKEN_INVALID",
                "status": status,
            }

        if _is_waf_response(raw, status):
            return {
                "success": False,
                "error": (
                    "WAF challenge blocked the request. "
                    "Set the QWEN_COOKIE environment variable with your chat.qwen.ai session cookie to authenticate."
                ),
                "code": "WAF_BLOCKED",
                "status": status,
            }

        if status != 200:
            return {
                "success": False,
                "error": f"HTTP {status}",
                "code": "HTTP_ERROR",
                "status": status,
                "raw": raw[:500],
            }

        data = json.loads(raw)

        thinking = ""
        answer = ""
        finish_reason = "stop"
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0

        choices = data.get("choices", [])
        if choices:
            choice = choices[0]
            finish_reason = choice.get("finish_reason", "stop") or "stop"
            msg = choice.get("message", {})
            content = msg.get("content", "")
            reasoning = msg.get("reasoning_content", "")

            if reasoning:
                thinking = reasoning
                answer = content
            else:
                answer = content

        # Fallback for alternative Qwen response shape
        if not answer:
            output = data.get("output", {})
            if isinstance(output, dict):
                choices2 = output.get("choices", [])
                if choices2:
                    msg2 = choices2[0].get("message", {})
                    answer = msg2.get("content", "")
                    thinking = msg2.get("reasoning_content", "")

        usage = data.get("usage", {})
        if usage:
            prompt_tokens = usage.get("input_tokens") or usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("output_tokens") or usage.get("completion_tokens", 0)
            total_tokens = usage.get("total_tokens", prompt_tokens + completion_tokens)

        # Estimate tokens if not provided
        if not prompt_tokens and final_messages:
            prompt_tokens = sum(len(m.get("content", "")) // 4 for m in final_messages)
        if not completion_tokens and answer:
            completion_tokens = len(answer) // 4
        if not total_tokens:
            total_tokens = prompt_tokens + completion_tokens

        return {
            "success": True,
            "response": answer or "(empty response)",
            "thinking": thinking or None,
            "finishReason": finish_reason,
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "totalTokens": total_tokens,
        }

    except json.JSONDecodeError as e:
        return {"success": False, "error": f"JSON parse error: {e}", "code": "PARSE_ERROR"}
    except Exception as e:
        return {"success": False, "error": str(e), "code": "EXCEPTION"}


def fetch_token() -> dict:
    """
    Fetch a fresh bx-umidtoken from Alibaba's UMI endpoint.

    The response is JavaScript (not JSON), e.g.:
        try{umx.wu('TOKEN_HERE');}catch(e){}
        try{__fycb('TOKEN_HERE');}catch(e){}

    We extract the token using a regex on the raw response body.
    curl_cffi is used when available for better TLS fingerprinting.
    """
    import re as _re
    import time as _time

    sources = [
        f"https://sg-wum.alibaba.com/w/wu.json?_t={int(_time.time()*1000)}",
        f"https://ynuf.aliapp.org/w/wu.json?_t={int(_time.time()*1000)}",
    ]

    headers_base = {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Origin": "https://chat.qwen.ai",
        "Referer": "https://chat.qwen.ai/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }

    # Regex to extract token from JS like: umx.wu('TOKEN') or __fycb('TOKEN')
    _token_re = _re.compile(r"(?:umx\.wu|__fycb)\(['\"]([^'\"]+)['\"]")

    def _extract_token(body: str):
        m = _token_re.search(body)
        return m.group(1) if m else None

    for url in sources:
        try:
            if HAS_CURL_CFFI:
                resp = cffi_requests.get(
                    url,
                    headers=headers_base,
                    impersonate=DEFAULT_IMPERSONATE,
                    timeout=15,
                )
                if resp.status_code == 200:
                    token = _extract_token(resp.text)
                    if token:
                        return {"success": True, "token": token, "source": url}
            else:
                import urllib.request as _ureq
                req = _ureq.Request(url, headers=headers_base, method="GET")
                with _ureq.urlopen(req, timeout=15) as r:
                    body = r.read().decode()
                    token = _extract_token(body)
                    if token:
                        return {"success": True, "token": token, "source": url}
        except Exception:
            continue  # try next source

    return {"success": False, "error": "All token sources failed"}


def main():
    try:
        raw = sys.stdin.read()
        inp = json.loads(raw)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Invalid input: {e}"}))
        sys.exit(1)

    action = inp.get("action")
    midtoken = inp.get("midtoken", "")
    model = inp.get("model", "qwen-plus")

    if action == "create_chat":
        result = create_chat(midtoken, model)
    elif action == "chat_completions":
        messages = inp.get("messages", [])
        chat_id = inp.get("chatId", str(uuid.uuid4()))
        result = chat_completions(
            midtoken=midtoken,
            model=model,
            messages=messages,
            chat_id=chat_id,
            temperature=inp.get("temperature"),
            top_p=inp.get("topP"),
            max_tokens=inp.get("maxTokens"),
            stop=inp.get("stop"),
            presence_penalty=inp.get("presencePenalty"),
            frequency_penalty=inp.get("frequencyPenalty"),
            seed=inp.get("seed"),
            response_format=inp.get("responseFormat"),
            tools=inp.get("tools"),
            tool_choice=inp.get("toolChoice"),
            reasoning_effort=inp.get("reasoningEffort"),
        )
    elif action == "fetch_token":
        result = fetch_token()
    else:
        result = {"success": False, "error": f"Unknown action: {action}"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
