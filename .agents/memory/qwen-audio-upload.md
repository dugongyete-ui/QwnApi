---
name: Qwen audio upload with token rotation
description: How to upload audio files to Qwen OSS and bypass per-token rate limits via automatic rotation through the bx-umidtoken pool.
---

# Qwen Audio Upload — Flow & Token Rotation

## The Rule
Audio upload uses the same OSS flow as image upload (`getstsToken` → OSS PUT → `/files/parse`), but with `filetype: "audio"` and a different file descriptor shape. Each bx-umidtoken has its own daily upload quota — rotate to the next token when one is rate-limited.

**Why:** The `getstsToken` endpoint returns `code: "RateLimited"` when a token hits its daily limit. Since the pool has 500+ tokens, rotating bypasses this without user-visible errors.

**How to apply:** Call `getAllPoolTokens()` (exported from `umid-pool.ts`) to get the full pool. Build a candidate list: primary token first, then all others. Loop until one succeeds or all are exhausted.

## File Descriptor Shape (audio)
```json
{
  "url": "https://oss-url...",
  "type": "audio",
  "file_type": "audio/mpeg",
  "file_class": "audio",
  "showType": "audio",
  "status": "uploaded",
  "name": "audio.mp3",
  "id": "file-id-from-sts"
}
```

## Token Rotation Pattern
```typescript
const candidates = [primaryToken, ...getAllPoolTokens().filter(t => t.token !== primaryToken)];
for (const candidate of candidates) {
  const sts = await getstsToken(candidate, "audio");
  if (sts.code === "RateLimited") continue;   // try next
  // ... upload and return descriptor
}
throw new Error("all tokens exhausted");
```

## Cookie Requirement
`getstsToken` needs `acw_tc` cookie. Fetch it first:
```typescript
const cookieRes = await fetch(QWEN_ORIGIN, { headers: { "bx-umidtoken": candidate.token } });
const cookie = cookieRes.headers.get("set-cookie")...
```

## Supported MIME Types
`audio/mpeg` (mp3), `audio/mp4` (m4a), `audio/wav`, `audio/ogg`, `audio/flac`, `audio/webm`.
Detection order: explicit `format` field → URL extension → default `audio/mpeg`.

## OpenAI Input Format
```json
{
  "type": "input_audio",
  "input_audio": { "url": "https://...", "format": "mp3" }
}
```
Or `"data": "<base64>"` instead of `"url"`.

## Key Files
- `artifacts/api-server/src/routes/v1.ts` — `uploadAudioToQwen()`, `resolveAudioFiles()`
- `artifacts/api-server/src/lib/umid-pool.ts` — `getAllPoolTokens()` export
