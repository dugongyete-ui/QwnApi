---
name: Qwen multimodal feature fixes
description: Root causes and fixes for vision, document, and audio failures in Qwen gateway
---

## Vision — image URL must be downloadable by the gateway server

`uploadImageToQwen` downloads the image bytes via curl before uploading to Qwen OSS.
Wikipedia image URLs return HTTP 400 when fetched by automated clients (hotlink protection).
Use URLs that allow programmatic access: gstatic.com, imgur, direct CDN links, or data URIs.

**Why:** The gateway must download the image first, then re-upload to Qwen OSS via STS token. If the download fails, `resolveImageUrls` silently skips the image (WARN log) and `files: []` is sent — model sees no image.

**How to apply:** When testing vision, use URLs that respond to curl/fetch (check with `curl -I <url>`). Data URIs (`data:image/jpeg;base64,...`) always work since no download is needed.

## Documents — text files must be inlined into prompt, not just OSS-uploaded

`files/parse` is called fire-and-forget after OSS upload. Qwen's parse is async; if the model receives the chat request before parsing completes, it has no document content and says "I can't access the file."

**Fix applied:** `messagesToTextPrompt()` now decodes base64 text-based documents (text/markdown, text/plain, text/csv, application/json, text/xml, text/html) and inlines them as `<document name="...">...</document>` blocks directly in the message text. The OSS upload still happens in parallel (for Qwen's search/RAG), but the model reads from the inline content.

**Why:** Binary files (PDF, DOCX) genuinely need OSS parse; text files can be inlined and it's far more reliable.

**How to apply:** Only applies to `file` content parts with `data` (base64) and a text MIME type. URL-only file refs and binary files still go through OSS.

## Audio — requires qwen2.5-omni-7b, not text-only models

`qwen3-30b-a3b` is text-only. Even if the audio file uploads successfully to Qwen OSS (`audio: files uploaded count: 1`), the model responds "I can't hear audio."

**Fix applied:** Added to QWEN_API_MODEL_MAP and MODELS:
- `qwen2.5-omni-7b` (native)
- `qwen-audio-turbo` → `qwen2.5-omni-7b`
- `qwen2-audio-instruct` → `qwen2.5-omni-7b`
- `qwen2.5-omni` → `qwen2.5-omni-7b`
- `qwen2.5-omni-turbo` → `qwen2.5-omni-7b`

**Why:** Omni models are trained for multimodal input including audio waveforms. Text models receive the audio file descriptor in `files[]` but their training doesn't include audio token processing.

**How to apply:** Any `input_audio` content part request should use one of the omni model aliases. The gateway's OSS upload flow (getstsToken → PUT → parse) works the same for audio.
