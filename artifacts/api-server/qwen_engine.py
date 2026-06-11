#!/usr/bin/env python3
"""
Qwen Gateway Engine — WAF bypass using curl_cffi for TLS fingerprint spoofing.
Reads JSON input from stdin, writes JSON result to stdout.
"""

import sys
import json
import time
import uuid

try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    import urllib.request
    import urllib.error
    HAS_CURL_CFFI = False


QWEN_BASE = "https://chat.qwen.ai/api/v2"
DEFAULT_IMPERSONATE = "chrome120"


def get_headers(midtoken: str) -> dict:
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://chat.qwen.ai",
        "Referer": "https://chat.qwen.ai/",
        "X-Requested-With": "XMLHttpRequest",
        "bx-umidtoken": midtoken,
        "bx-v": "2.5.31",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }


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
            data = resp.json()
        else:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode(),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode())

        chat_id = data.get("data", {}).get("chat", {}).get("id") or data.get("id")
        if not chat_id:
            chat_id = str(uuid.uuid4())

        return {"success": True, "chatId": chat_id}

    except Exception as e:
        return {"success": False, "error": str(e), "chatId": str(uuid.uuid4())}


def chat_completions(midtoken: str, model: str, messages: list, chat_id: str) -> dict:
    """Send messages and return the AI response."""
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "incremental_output": False,
        "chat_id": chat_id,
        "id": str(uuid.uuid4()),
    }

    url = f"{QWEN_BASE}/chat/completions"
    headers = get_headers(midtoken)

    try:
        if HAS_CURL_CFFI:
            resp = cffi_requests.post(
                url,
                json=payload,
                headers=headers,
                impersonate=DEFAULT_IMPERSONATE,
                timeout=60,
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
                with urllib.request.urlopen(req, timeout=60) as r:
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

        choices = data.get("choices", [])
        if choices:
            msg = choices[0].get("message", {})
            content = msg.get("content", "")
            reasoning = msg.get("reasoning_content", "")

            if reasoning:
                thinking = reasoning
                answer = content
            else:
                answer = content

        if not answer:
            output = data.get("output", {})
            if isinstance(output, dict):
                choices2 = output.get("choices", [])
                if choices2:
                    msg2 = choices2[0].get("message", {})
                    answer = msg2.get("content", "")
                    thinking = msg2.get("reasoning_content", "")

        token_usage = None
        usage = data.get("usage", {})
        if usage:
            token_usage = usage.get("total_tokens")

        return {
            "success": True,
            "response": answer or "(empty response)",
            "thinking": thinking or None,
            "tokenUsage": token_usage,
        }

    except json.JSONDecodeError as e:
        return {"success": False, "error": f"JSON parse error: {e}", "code": "PARSE_ERROR"}
    except Exception as e:
        return {"success": False, "error": str(e), "code": "EXCEPTION"}


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
        result = chat_completions(midtoken, model, messages, chat_id)
    else:
        result = {"success": False, "error": f"Unknown action: {action}"}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
