---
name: Qwen V2 API engine interface
description: How the Node.js gateway talks to chat.qwen.ai — Python sidecar CLI, chat creation, completions URL, and SSE parsing.
---

# Qwen V2 Engine Interface

## Architecture
Node.js routes → Python subprocess (`qwen_cffi.py`) → chat.qwen.ai API

The Python sidecar handles all HTTP calls to Qwen because `curl_cffi` without `impersonate=` bypasses Aliyun WAF (Node.js fetch is blocked from datacenter IPs).

## Chat Creation
```
POST /api/v2/chats/new
{ "title": "New Chat", "models": [model], "chat_mode": "normal", "chat_type": "t2t", "timestamp": <ms> }
→ { "success": true, "data": { "id": "<chat_id>" } }
```
Node helper: `qwenPyCreate(token, model, midtoken?)` → returns `chat_id` string.

## Completions
```
POST /api/v2/chat/completions?chat_id=<id>
Body: { model, messages, stream: true, incremental_output: true, chat_id, chat_mode, ... }
→ SSE stream
```
Node helper: `qwenPyBody(token, chatId, payload, midtoken?)` → returns full SSE body string.

## SSE Parsing (`parseQwenSSE`)
- Normal content: `choices[0].delta.content` where `extra.output_schema === "answer"` (fallback: any content)
- Token usage: `usage.input_tokens` / `usage.output_tokens` in the final chunk
- Upstream error: `chunk.error` object → surfaced as gateway error
- Risk control: `FAIL_SYS_USER_VALIDATE` or `_____tmd_____` in first chunk → retry up to 3×

## Guest Mode (bx-umidtoken)
- Pass `midtoken` arg to `qwenPyCreate`/`qwenPyBody`; token="" for session mode
- Pool: `artifacts/api-server/src/lib/umid-pool.ts` — 509 UAs, tokens cached in `token_cache.json`
- `getPooledMidtoken()` — round-robin pick
- `getAllPoolTokens()` — all tokens (for rotation on rate limits)

## File Upload (OSS)
For vision/audio, upload goes directly from Node.js (not via Python), using:
1. `POST /api/v2/files/getstsToken` with `filetype: "image"|"audio"|"doc"`
2. `PUT https://{bucket}.{endpoint}/{path}` — HMAC-SHA1 signed
3. `POST /api/v2/files/parse` — notify Qwen to process

Both steps need `bx-umidtoken` + `acw_tc` cookie (fetched by hitting QWEN_ORIGIN first).

## Environment Variables
- `QWEN_SESSION_TOKEN` — optional Bearer token for logged-in mode (unlocks more quota)
- `ADMIN_API_KEY` — gateway API key for `/v1/*` endpoints
