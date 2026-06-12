#!/usr/bin/env python3
"""
Qwen API proxy using curl_cffi (no TLS impersonation) to bypass Aliyun WAF.

WAF bypass: curl_cffi without impersonation uses a TLS fingerprint not in
Aliyun's datacenter blocklist, while Node.js fetch and system curl are blocked.

Usage (session mode — logged-in token):
  python3 qwen_cffi.py create <TOKEN> <MODEL>
  python3 qwen_cffi.py chat   <TOKEN> <CHAT_ID> <PAYLOAD_BASE64>
  python3 qwen_cffi.py upload <TOKEN> <IMAGE_SOURCE_BASE64>

Usage (guest mode — no login, uses bx-umidtoken):
  python3 qwen_cffi.py create "" <MODEL> <MIDTOKEN>
  python3 qwen_cffi.py chat   "" <CHAT_ID> <PAYLOAD_BASE64> <MIDTOKEN>

Vision note: upload requires a valid session TOKEN. Guest mode does not
support image upload. Without TOKEN, vision requests return an error.
"""
import sys
import json
import time
import base64
import urllib.request
import urllib.parse
import curl_cffi.requests as req
from curl_cffi import CurlMime

ORIGIN = "https://chat.qwen.ai"
BASE   = f"{ORIGIN}/api/v2"

MAX_RETRIES = 3
RETRY_DELAY = 3.0


def _headers(token: str, midtoken: str = "") -> dict:
    h = {
        "Content-Type":     "application/json",
        "Origin":           ORIGIN,
        "Referer":          f"{ORIGIN}/",
        "X-Requested-With": "XMLHttpRequest",
        "X-Source":         "web",
        "bx-v":             "2.5.31",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    if midtoken:
        h["bx-umidtoken"] = midtoken
    return h


def _headers_no_ct(token: str, midtoken: str = "") -> dict:
    """Headers without Content-Type (for multipart — let curl set it)."""
    h = {
        "Origin":           ORIGIN,
        "Referer":          f"{ORIGIN}/",
        "X-Requested-With": "XMLHttpRequest",
        "X-Source":         "web",
        "bx-v":             "2.5.31",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    if midtoken:
        h["bx-umidtoken"] = midtoken
    return h


def _is_risk_control(text: str) -> bool:
    """Detect Qwen risk-control / server-overload response."""
    return "FAIL_SYS_USER_VALIDATE" in text or "_____tmd_____" in text


def cmd_create(token: str, model: str, midtoken: str = "") -> None:
    r = req.post(
        f"{BASE}/chats/new",
        json={
            "title":     "New Chat",
            "models":    [model],
            "chat_mode": "normal",
            "chat_type": "t2t",
            "timestamp": int(time.time() * 1000),
        },
        headers=_headers(token, midtoken),
        timeout=15,
    )
    sys.stdout.write(r.text)
    sys.stdout.flush()


def cmd_chat(token: str, chat_id: str, payload_b64: str, midtoken: str = "") -> None:
    # "-" means read JSON payload from stdin (avoids ARG_MAX limit for large payloads)
    if payload_b64 == "-":
        payload = json.loads(sys.stdin.read())
    else:
        payload = json.loads(base64.b64decode(payload_b64).decode("utf-8"))

    for attempt in range(MAX_RETRIES):
        chunks: list[bytes] = []
        first_chunk_checked = False
        risk_hit = False

        r = req.post(
            f"{BASE}/chat/completions?chat_id={chat_id}",
            json=payload,
            headers=_headers(token, midtoken),
            stream=True,
            timeout=90,
        )

        for chunk in r.iter_content():
            if not first_chunk_checked:
                first_chunk_checked = True
                sample = chunk.decode("utf-8", errors="replace")
                if _is_risk_control(sample):
                    risk_hit = True
                    break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()

        if not risk_hit:
            return  # success

        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_DELAY * (attempt + 1))  # back-off: 3s, 6s
        else:
            err_msg = json.dumps({
                "error": {
                    "message": "Qwen server busy / risk-control triggered. Please retry in a moment.",
                    "type": "upstream_error",
                    "code": "qwen_risk_control",
                }
            })
            sys.stdout.write(f"data: {err_msg}\n\ndata: [DONE]\n\n")
            sys.stdout.flush()
            sys.exit(2)


def cmd_upload(token: str, image_source_b64: str) -> None:
    """
    Upload an image to Qwen CDN and print the resulting file URL as JSON.
    image_source_b64: base64-encoded string that is either:
      - A URL  (http:// or https://)
      - A data URI  (data:image/...;base64,...)
    Prints: {"ok": true, "url": "https://..."} or {"ok": false, "error": "..."}
    Requires a valid session token.
    """
    if not token:
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": "vision_requires_auth",
            "message": (
                "Image analysis requires QWEN_SESSION_TOKEN. "
                "Set it to your Qwen Bearer token "
                "(chat.qwen.ai → DevTools → Network → Authorization header)."
            )
        }))
        sys.stdout.flush()
        return

    image_source = base64.b64decode(image_source_b64).decode("utf-8")

    # ── Decode image bytes ────────────────────────────────────────────────────
    img_bytes: bytes
    content_type: str
    filename: str

    if image_source.startswith("data:"):
        # data:<mime>;base64,<data>
        try:
            meta, data = image_source.split(",", 1)
            content_type = meta.split(";")[0].split(":")[1]
            img_bytes = base64.b64decode(data)
            ext = content_type.split("/")[-1].split("+")[0]  # e.g. jpeg, png, webp
            filename = f"image.{ext}"
        except Exception as e:
            sys.stdout.write(json.dumps({"ok": False, "error": f"bad_data_url: {e}"}))
            sys.stdout.flush()
            return
    else:
        # External URL — download via curl_cffi (WAF-safe)
        try:
            dl = req.get(image_source, timeout=30, allow_redirects=True)
            img_bytes = dl.content
            ct_header = dl.headers.get("content-type", "image/jpeg")
            content_type = ct_header.split(";")[0].strip() or "image/jpeg"
            # Guess filename from URL path
            path = urllib.parse.urlparse(image_source).path
            basename = path.rstrip("/").split("/")[-1] or "image"
            if "." not in basename:
                ext = content_type.split("/")[-1].split("+")[0]
                basename = f"{basename}.{ext}"
            filename = basename
        except Exception as e:
            sys.stdout.write(json.dumps({"ok": False, "error": f"download_failed: {e}"}))
            sys.stdout.flush()
            return

    if len(img_bytes) < 10:
        sys.stdout.write(json.dumps({"ok": False, "error": "downloaded_image_too_small"}))
        sys.stdout.flush()
        return

    # ── Upload to Qwen ────────────────────────────────────────────────────────
    form = CurlMime()
    form.addpart(name="file", content_type=content_type, filename=filename, data=img_bytes)

    try:
        r = req.post(
            f"{BASE}/files/upload",
            multipart=form,
            headers=_headers_no_ct(token),
            timeout=30,
        )
        data = r.json()
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": f"upload_request_failed: {e}"}))
        sys.stdout.flush()
        return

    if not data.get("success"):
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": data.get("data", {}).get("code", "upload_failed"),
            "details": data.get("data", {}).get("details", ""),
        }))
        sys.stdout.flush()
        return

    # Extract CDN URL and file_id from response
    resp_data = data.get("data", {}) or {}
    file_url = (
        resp_data.get("url")
        or resp_data.get("file_url")
        or resp_data.get("cdn_url")
    )
    file_id = resp_data.get("file_id") or resp_data.get("id") or ""
    if not file_url:
        sys.stdout.write(json.dumps({"ok": False, "error": "no_url_in_response", "raw": str(data)[:200]}))
        sys.stdout.flush()
        return

    sys.stdout.write(json.dumps({
        "ok": True,
        "url": file_url,
        "file_id": file_id,
        "filename": filename,
        "content_type": content_type,
        "size": len(img_bytes),
    }))
    sys.stdout.flush()


def main() -> None:
    cmd      = sys.argv[1]
    token    = sys.argv[2]        # session token, or "" for guest mode
    if cmd == "create":
        model    = sys.argv[3]
        midtoken = sys.argv[4] if len(sys.argv) > 4 else ""
        cmd_create(token, model, midtoken)
    elif cmd == "chat":
        chat_id  = sys.argv[3]
        payload  = sys.argv[4]
        midtoken = sys.argv[5] if len(sys.argv) > 5 else ""
        cmd_chat(token, chat_id, payload, midtoken)
    elif cmd == "upload":
        image_source_b64 = sys.argv[3]
        cmd_upload(token, image_source_b64)
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


main()
