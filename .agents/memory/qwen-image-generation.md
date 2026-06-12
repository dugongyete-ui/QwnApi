---
name: Qwen image generation (t2i) trick
description: How to generate images via chat.qwen.ai using qwen3.7-plus with chat_type t2i inside the message object — NOT via wanx/flux model names.
---

# Qwen Image Generation — The t2i Trick

## The Rule
Do NOT use `wanx*` or `flux` as the model name — they return "Model not found" on `/api/v2/chat/completions`. Instead, use **`qwen3.7-plus`** (a valid model) and embed `chat_type: "t2i"` and `sub_chat_type: "t2i"` **inside the message object**.

**Why:** The `/api/v2/models` endpoint only exposes 3 text models. The wanx image-gen backend is not accessible via the completions endpoint directly. But `qwen3.7-plus` can internally route to Wan image generation when the message-level chat_type signals t2i mode.

**How to apply:** Create a normal t2t chat with `qwenPyCreate("", "qwen3.7-plus", midtoken)`, then build the completions payload with the t2i fields in the message. Route through the Python sidecar for WAF bypass.

## Critical Payload Shape
```json
{
  "stream": true,
  "incremental_output": true,
  "chat_id": "<chatId>",
  "chat_mode": "normal",
  "model": "qwen3.7-plus",
  "parent_id": null,
  "messages": [{
    "fid": "<uuid>",
    "parentId": null,
    "childrenIds": [],
    "role": "user",
    "content": "<prompt>",
    "user_action": "chat",
    "files": [],
    "models": ["qwen3.7-plus"],
    "chat_type": "t2i",
    "feature_config": { "thinking_enabled": false },
    "sub_chat_type": "t2i"
  }]
}
```

## Response Format
The SSE stream emits keep_alive pings (~10s each), then a final `choices[0].delta.content` chunk containing the full signed CDN URL. Accumulate all content chunks — the result is the image URL.

```
data: {"response.info": {"action": "keep_alive", ...}}
data: {"choices": [{"delta": {"content": "https://cdn.qwenlm.ai/output/.../image.png?key=..."}}]}
data: [DONE]
```

## API Endpoint
`POST /v1/images/generations` — OpenAI-compatible.
- `prompt` (required), `n` (1–4, default 1)
- Returns `{ created, data: [{ url }] }`
- All images generated in parallel via `Promise.all`

## Timeout Note
Image generation takes ~20–60s per image due to keep_alive pings. Set sidecar timeout ≥ 180s.

## What Does NOT Work
- `wanx3.0-t2i-turbo`, `wanx2.1-t2i-turbo`, `flux-schnell` — all return "Model not found" at completions
- Creating chat with `chat_type: "t2i"` at the chat level then using wanx model — same error
- Using `impersonate="chrome110"` in cffi — WAF blocks it; must use NO impersonate

## Key Files
- `artifacts/api-server/src/routes/v1.ts` — `router.post("/images/generations", ...)`
- Source: Reverse-engineered from `dugongyete-ui/Chat-GatewayV2` GitHub repo (same project, different branch with more providers)
