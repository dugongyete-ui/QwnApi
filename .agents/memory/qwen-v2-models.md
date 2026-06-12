---
name: Qwen V2 model names and aliases
description: Which model IDs chat.qwen.ai actually accepts, and how the gateway maps OpenAI-style names to them.
---

# Qwen V2 Model Names (June 2026)

## Models Confirmed Working at chat.qwen.ai
From `/api/v2/models` (only 3 listed):
- `qwen3.7-plus` — vision, audio, video, thinking, search
- `qwen3.7-max` — document, thinking
- `qwen3.6-plus` — vision, audio, video, thinking, search

## QWEN_API_MODEL_MAP Aliases (v1.ts)
OpenAI-style → internal Qwen model:

| OpenAI alias | Qwen model |
|---|---|
| `qwen3-235b-a22b` | `qwen3-235b-a22b` |
| `qwen3-30b-a3b` | `qwen3-30b-a3b` |
| `qwen-turbo` | `qwen3.5-flash` |
| `qwen-plus` | `qwen3.7-plus` |
| `qwen-max` | `qwen3.7-max` |
| `qwen-vl-max`, `qwen-vl` | `qwen3.7-max` |
| `qwen-vl-plus` | `qwen3.6-plus` |
| `qwen2.5-vl-72b-instruct` | `qwen3-235b-a22b` |
| `qwen2.5-vl-7b-instruct` | `qwen3-30b-a3b` |
| `qwen2.5-omni-7b` | `qwen3.6-plus` |

## Image Generation
Uses `qwen3.7-plus` with `chat_type: "t2i"` inside message — NOT wanx/flux model names.
See `qwen-image-generation.md` for full details.

## What Does NOT Work
- `qwen-turbo`, `qwen-plus`, `qwen-max` directly (old V1 names) → "Not_Found"
- `wanx*`, `flux-*` at completions endpoint → "Model not found"
- Any model not in the map gets passed through as-is (may fail at Qwen side)
